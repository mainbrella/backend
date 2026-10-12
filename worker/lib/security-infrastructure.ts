export async function operatorAuthorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token || !/^[\x21-\x7e]{32,256}$/.test(token)) return false;
  const received = request.headers.get('Authorization') ?? '';
  const expected = `Bearer ${token}`;
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(received), digest(expected)]);
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference = 0;
  for (let at = 0; at < left.length; at++) difference |= left[at] ^ right[at];
  return difference === 0;
}

export const infrastructureError = (error: string, status: number) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
