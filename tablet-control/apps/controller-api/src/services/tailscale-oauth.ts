export interface TailscaleOAuthConfig {
  clientId: string;
  clientSecret: string;
  tailnet: string;
}

export interface TailscaleAuthKey {
  id: string;
  key: string;
  created: string;
  expires: string;
}

export class TailscaleOAuthService {
  private config: TailscaleOAuthConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: TailscaleOAuthConfig) {
    this.config = config;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    // Buffer of 5 minutes before expiration
    if (this.accessToken && this.tokenExpiresAt > now + 5 * 60 * 1000) {
      return this.accessToken;
    }

    const params = new URLSearchParams();
    params.append('client_id', this.config.clientId);
    params.append('client_secret', this.config.clientSecret);
    params.append('grant_type', 'client_credentials');

    const response = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get Tailscale OAuth token: ${response.status} ${errorText}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + data.expires_in * 1000;
    
    return this.accessToken;
  }

  public async generateAuthKey(tags: string[] = ['tag:roshan-tablet']): Promise<TailscaleAuthKey> {
    const token = await this.getAccessToken();
    const tailnet = this.config.tailnet;

    const payload = {
      capabilities: {
        devices: {
          create: {
            reusable: false,
            ephemeral: false,
            preauthorized: true,
            tags: tags,
          }
        }
      }
    };

    const response = await fetch(`https://api.tailscale.com/api/v2/tailnet/${tailnet}/keys`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to generate Tailscale AuthKey: ${response.status} ${errorText}`);
    }

    return await response.json() as TailscaleAuthKey;
  }
}
