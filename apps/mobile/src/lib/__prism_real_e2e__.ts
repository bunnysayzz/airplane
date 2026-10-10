// Lightweight fetch wrapper with retry for the mobile app.
export async function fetchWithRetry(
  url: string,
  retries = 3,
): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch (err) {
      if (i === retries) throw err;
    }
  }
  throw new Error("unreachable");
}
