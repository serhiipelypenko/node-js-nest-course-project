// «Клієнт без ключів» для multipart. Два режими, обидва — окремі ПРОЦЕСИ:
//
//   start  <api> <token> <size> <dieAfter>  intent + заливати частини; після
//          dieAfter-ї частини вбиває себе SIGKILL (без finally, без Abort —
//          так помирає мобільний клієнт у метро чи контейнер від OOM).
//   resume <api> <token> <id>               спитати СЕРВЕР, що вже лежить у
//          сховищі (GET /uploads/:id/parts -> ListParts), і долити ТІЛЬКИ те,
//          чого бракує.
//
// Тіло частини детерміноване: n-та заповнена байтом 96+n. Ключів сховища тут
// немає: URL частин приходять від API.
const body = (n: number, len: number): Buffer => Buffer.alloc(len, 96 + n);

async function api(base: string, token: string, method: string, path: string, json?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json() as Promise<any>;
}

async function putPart(url: string, n: number, len: number) {
  const res = await fetch(url, { method: 'PUT', body: body(n, len), signal: AbortSignal.timeout(60_000) });
  if (res.status !== 200) throw new Error(`PUT part ${n} -> ${res.status}`);
}

async function main() {
  const [mode, base, token, a, b] = process.argv.slice(2);
  if (mode === 'start') {
    const d = await api(base, token, 'POST', '/uploads/intent', {
      filename: 'big.bin', contentType: 'application/octet-stream', size: Number(a),
    });
    console.log(`ID ${d.id}`);
    for (const p of d.multipart.parts) {
      await putPart(p.url, p.part_number, p.length);
      console.log(`PART ${p.part_number}`);
      if (p.part_number >= Number(b)) {
        console.log('DIE');
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => undefined);
      }
    }
  } else {
    const d = await api(base, token, 'GET', `/uploads/${a}/parts`);
    console.log(`HAVE ${d.uploaded.map((p: any) => p.part_number).join(',')}`);
    for (const p of d.missing) {
      await putPart(p.url, p.part_number, p.length);
      console.log(`REUPLOAD ${p.part_number}`);
    }
  }
}
main().catch((e) => { console.error(String(e)); process.exit(1); });

export {}; // модуль, а не глобальний скрипт (інакше main колідує)
