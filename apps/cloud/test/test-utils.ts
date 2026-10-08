// Test utilities

export interface TestClient {
  fetch: (url: string, options?: RequestInit) => Promise<Response>;
  withSession: (sessionId: string) => TestClient;
}

export function createTestClient(baseURL: string, env?: { [key: string]: string }): TestClient {
  const sessionCookies: string[] = [];

  function parseCookies(headers: Headers) {
    const cookieHeader = headers.get('set-cookie');
    if (cookieHeader) {
      sessionCookies.push(cookieHeader);
    }
  }

  const client: TestClient = {
    fetch: async (url: string, options: RequestInit = {}) => {
      const headers = new Headers(options.headers);
      
      // Add session cookies
      if (sessionCookies.length > 0) {
        const allCookies = sessionCookies
          .map(c => c.match(/__Host-swarmforge=([^;]+)/)?.[1])
          .filter(Boolean);
        if (allCookies.length > 0) {
          headers.set('Cookie', `__Host-swarmforge=${allCookies[0]}`);
        }
      }

      // Add default headers
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      if (!headers.has('Origin') && options.method !== 'OPTIONS') {
        headers.set('Origin', 'https://app.example.com');
      }

      const res = await fetch(url, {
        ...options,
        headers,
      });

      parseCookies(res.headers);
      return res;
    },

    withSession: (sessionId: string) => {
      sessionCookies.length = 0;
      sessionCookies.push(`__Host-swarmforge=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Lax`);
      return client;
    },
  };

  return client;
}

export function generateId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
