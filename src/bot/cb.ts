const store = new Map<string, string>();
let counter = 0;

export function encodeCb(payload: string): string {
  try {
    const b64 = Buffer.from(payload, 'utf8').toString('base64').replace(/=+$/,'');
    return `e:${b64}`;
  } catch {
    const key = `h:${(++counter).toString(36)}`;
    store.set(key, payload);
    return key;
  }
}

export function decodeCb(data: string): string {
  if (data.startsWith('e:')) {
    const b64 = data.slice(2);
    try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return data; }
  }
  if (data.startsWith('h:')) {
    if (store.has(data)) return store.get(data)!;
    return '__expired__';
  }
  return data;
}
