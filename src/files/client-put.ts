// «Клієнт без ключів»: окремий процес, у якого в оточенні НЕМАЄ жодного
// креденшела сховища — лише presigned URL у аргументі. Запускається демо з
// env: {} . Якщо PUT проходить (200), байти доїхали у сховище повз наш API
// (на цей момент він ще й вимкнений).
//   node client-put.js <url> <contentType> <length>
async function main() {
  const [url, contentType, length] = process.argv.slice(2);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: Buffer.alloc(Number(length), 'u'),
    signal: AbortSignal.timeout(30_000),
  });
  console.log(res.status);
}
main().catch((e) => { console.error(e); console.log(0); });

export {}; // модуль, а не глобальний скрипт (інакше main колідує)
