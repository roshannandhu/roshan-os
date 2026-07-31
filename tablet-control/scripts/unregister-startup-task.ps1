Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName = "TabletControllerAutoStart"

Write-Host "Removing task $taskName..."
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "Task removed."
