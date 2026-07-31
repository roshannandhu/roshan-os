package com.tabletcontrol.companion

import android.util.Log
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore

data class HttpRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: String,
    val rawBody: ByteArray = ByteArray(0)
)

class HttpResponse(
    val status: Int,
    val body: String = "",
    val contentType: String = "application/json; charset=utf-8",
    val streamBody: InputStream? = null,
    val onClose: (() -> Unit)? = null,
    val rawBody: ByteArray? = null
)

class SimpleHttpServer(
    private val port: Int,
    private val handler: (HttpRequest) -> HttpResponse
) {
    data class ListenerSnapshot(
        val listening: Boolean,
        val port: Int,
        val startedAtMs: Long,
        val lastAcceptedAtMs: Long,
        val lastErrorAtMs: Long,
        val lastError: String?
    )

    private companion object {
        const val TAG = "CompanionHttp"
        const val MAX_REQUEST_BODY_BYTES = 65_536
        const val MAX_REQUEST_LINE_BYTES = 4_096
        const val MAX_HEADER_LINE_BYTES = 8_192
        const val MAX_HEADER_BYTES = 32_768
        const val CLIENT_THREADS = 8
        const val MAX_CONNECTED_CLIENTS = 16
    }

    private val lifecycleLock = Any()

    @Volatile
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var clientPool: ExecutorService? = null

    @Volatile
    private var startedAtMs = 0L

    @Volatile
    private var lastAcceptedAtMs = 0L

    @Volatile
    private var lastErrorAtMs = 0L

    @Volatile
    private var lastError: String? = null

    private val connectedClients = ConcurrentHashMap.newKeySet<Socket>()
    private val clientSlots = Semaphore(MAX_CONNECTED_CLIENTS, true)

    fun start(): Boolean {
        synchronized(lifecycleLock) {
            if (serverSocket?.isClosed == false) return true

            return try {
                val socket = ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress(port))
                }
                val pool = Executors.newFixedThreadPool(CLIENT_THREADS) { runnable ->
                    Thread(runnable, "roshan-http-client").apply { isDaemon = true }
                }
                serverSocket = socket
                clientPool = pool
                startedAtMs = System.currentTimeMillis()
                lastError = null

                Thread(
                    { acceptLoop(socket, pool) },
                    "roshan-http-listener"
                ).apply {
                    isDaemon = true
                    start()
                }
                Log.i(TAG, "Listening on port $port")
                true
            } catch (error: Exception) {
                recordError("listener start failed: ${error.message ?: error.javaClass.simpleName}")
                Log.e(TAG, "Could not bind companion listener on port $port", error)
                false
            }
        }
    }

    fun stop() {
        synchronized(lifecycleLock) {
            val socket = serverSocket
            serverSocket = null
            try {
                socket?.close()
            } catch (_: Exception) {
            }
            connectedClients.forEach { client ->
                try {
                    client.close()
                } catch (_: Exception) {
                }
            }
            connectedClients.clear()
            clientPool?.shutdownNow()
            clientPool = null
        }
    }

    fun isRunning(): Boolean = serverSocket?.isClosed == false

    fun snapshot(): ListenerSnapshot = ListenerSnapshot(
        listening = isRunning(),
        port = port,
        startedAtMs = startedAtMs,
        lastAcceptedAtMs = lastAcceptedAtMs,
        lastErrorAtMs = lastErrorAtMs,
        lastError = lastError
    )

    private fun acceptLoop(socket: ServerSocket, pool: ExecutorService) {
        try {
            while (!socket.isClosed) {
                try {
                    val client = socket.accept()
                    if (
                        !InboundPeerPolicy.isAllowed(
                            client.inetAddress,
                            client.localAddress
                        )
                    ) {
                        try {
                            client.close()
                        } catch (_: Exception) {
                        }
                        continue
                    }
                    lastAcceptedAtMs = System.currentTimeMillis()
                    if (!clientSlots.tryAcquire()) {
                        try {
                            client.close()
                        } catch (_: Exception) {
                        }
                        continue
                    }
                    connectedClients += client
                    try {
                        pool.execute {
                            try {
                                handle(client)
                            } finally {
                                connectedClients -= client
                                clientSlots.release()
                            }
                        }
                    } catch (error: Exception) {
                        connectedClients -= client
                        clientSlots.release()
                        try {
                            client.close()
                        } catch (_: Exception) {
                        }
                        if (!socket.isClosed) {
                            recordError(
                                "client worker rejected: ${error.message ?: error.javaClass.simpleName}"
                            )
                        }
                    }
                } catch (error: Exception) {
                    if (!socket.isClosed) {
                        recordError(
                            "listener accept failed: ${error.message ?: error.javaClass.simpleName}"
                        )
                        Log.e(TAG, "Companion listener stopped unexpectedly", error)
                    }
                    break
                }
            }
        } finally {
            synchronized(lifecycleLock) {
                if (serverSocket === socket) {
                    try {
                        socket.close()
                    } catch (_: Exception) {
                    }
                    serverSocket = null
                    clientPool?.shutdownNow()
                    clientPool = null
                }
            }
        }
    }

    private fun handle(socket: Socket) {
        var response: HttpResponse? = null
        try {
            socket.soTimeout = 30_000
            val input = socket.getInputStream()
            val output = socket.getOutputStream()

            val requestLine = readHttpLine(input, MAX_REQUEST_LINE_BYTES) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) {
                writeFixedResponse(output, HttpResponse(400, """{"ok":false,"error":"bad request"}"""))
                return
            }
            val method = parts[0]
            val path = parts[1].substringBefore("?")
            if (method != "GET" && method != "POST") {
                writeFixedResponse(
                    output,
                    HttpResponse(405, """{"ok":false,"error":"method not allowed"}""")
                )
                return
            }

            val headers = mutableMapOf<String, String>()
            var headerBytes = 0
            while (true) {
                val line = readHttpLine(input, MAX_HEADER_LINE_BYTES) ?: break
                if (line.isEmpty()) break
                headerBytes += line.toByteArray(Charsets.UTF_8).size + 2
                if (headerBytes > MAX_HEADER_BYTES) {
                    writeFixedResponse(
                        output,
                        HttpResponse(413, """{"ok":false,"error":"request headers too large"}""")
                    )
                    return
                }
                val colon = line.indexOf(':')
                if (colon > 0) {
                    headers[line.substring(0, colon).trim().lowercase()] =
                        line.substring(colon + 1).trim()
                }
            }

            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            if (contentLength < 0 || contentLength > MAX_REQUEST_BODY_BYTES) {
                writeFixedResponse(
                    output,
                    HttpResponse(413, """{"ok":false,"error":"request body too large"}""")
                )
                return
            }
            val rawBody = readBody(input, contentLength)
            val request = HttpRequest(
                method = method,
                path = path,
                headers = headers,
                body = rawBody.toString(Charsets.UTF_8),
                rawBody = rawBody
            )
            response = handler(request)

            val stream = response.streamBody
            if (stream == null) {
                writeFixedResponse(output, response)
                return
            }

            socket.soTimeout = 0
            writeHeaders(
                output,
                response.status,
                response.contentType,
                listOf(
                    "Transfer-Encoding: chunked",
                    "Cache-Control: no-store",
                    "Connection: close"
                )
            )
            val buffer = ByteArray(8192)
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                output.write("${count.toString(16)}\r\n".toByteArray(Charsets.US_ASCII))
                output.write(buffer, 0, count)
                output.write("\r\n".toByteArray(Charsets.US_ASCII))
                output.flush()
            }
            output.write("0\r\n\r\n".toByteArray(Charsets.US_ASCII))
            output.flush()
        } catch (error: Exception) {
            Log.w(TAG, "Client connection ended: ${error.message}")
        } finally {
            try {
                response?.streamBody?.close()
            } catch (_: Exception) {
            }
            try {
                response?.onClose?.invoke()
            } catch (_: Exception) {
            }
            try {
                socket.close()
            } catch (_: Exception) {
            }
            connectedClients -= socket
        }
    }

    private fun readBody(input: InputStream, contentLength: Int): ByteArray {
        if (contentLength == 0) return ByteArray(0)
        val buffer = ByteArray(contentLength)
        var offset = 0
        while (offset < buffer.size) {
            val count = input.read(buffer, offset, buffer.size - offset)
            if (count < 0) break
            offset += count
        }
        return if (offset == buffer.size) buffer else buffer.copyOf(offset)
    }

    private fun writeFixedResponse(output: java.io.OutputStream, response: HttpResponse) {
        val responseBytes = response.rawBody ?: response.body.toByteArray(Charsets.UTF_8)
        writeHeaders(
            output,
            response.status,
            response.contentType,
            listOf(
                "Content-Length: ${responseBytes.size}",
                "Connection: close"
            )
        )
        output.write(responseBytes)
        output.flush()
    }

    private fun writeHeaders(
        output: java.io.OutputStream,
        status: Int,
        contentType: String,
        extraHeaders: List<String>
    ) {
        val headers = buildString {
            append("HTTP/1.1 $status ${statusText(status)}\r\n")
            append("Content-Type: $contentType\r\n")
            extraHeaders.forEach { append(it).append("\r\n") }
            append("\r\n")
        }
        output.write(headers.toByteArray(Charsets.US_ASCII))
        output.flush()
    }

    // Reads a CRLF-terminated HTTP header line without buffering into the body.
    private fun readHttpLine(input: InputStream, maximumBytes: Int): String? {
        val builder = StringBuilder()
        var previousWasCr = false
        var bytesRead = 0
        while (true) {
            val value = input.read()
            if (value < 0) return if (builder.isEmpty()) null else builder.toString()
            bytesRead += 1
            if (bytesRead > maximumBytes) {
                throw IllegalArgumentException("HTTP line exceeded the configured limit")
            }
            val character = value.toChar()
            if (previousWasCr && character == '\n') {
                if (builder.isNotEmpty()) builder.deleteCharAt(builder.length - 1)
                return builder.toString()
            }
            builder.append(character)
            previousWasCr = character == '\r'
        }
    }

    private fun recordError(message: String) {
        lastErrorAtMs = System.currentTimeMillis()
        lastError = message
    }

    private fun statusText(code: Int): String = when (code) {
        200 -> "OK"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        409 -> "Conflict"
        413 -> "Payload Too Large"
        423 -> "Locked"
        429 -> "Too Many Requests"
        500 -> "Internal Server Error"
        502 -> "Bad Gateway"
        else -> "Unknown"
    }
}
