// hw-32, сходинка 3 «Архітектура»: фраза з README «модулі не лізуть один в одного» як перевірюване правило.
// Шляхи — без прив'язки до кореня репо ((^|/)src/…), тому ті самі правила діють і на зумисно зламаному
// вході fixtures/arch-broken/src (demo:gates).
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'products-not-to-orders',
      severity: 'error',
      comment: 'orders залежить від products (ціни позицій), а не навпаки: зворотний імпорт робить цикл і зливає домени',
      from: { path: '(^|/)src/products/' },
      to: { path: '(^|/)src/orders/' },
    },
    {
      name: 'common-is-leaf',
      severity: 'error',
      comment: 'src/common — листок: problem+json і курсор не знають про жоден доменний модуль',
      from: { path: '(^|/)src/common/' },
      to: { path: '(^|/)src/(products|orders|auth|files|outbox|messaging|storage|cdn)/' },
    },
    {
      name: 'auth-not-to-features',
      severity: 'error',
      comment: 'auth — глобальний модуль: ним користуються ресурси, сам він ресурсів не імпортує',
      from: { path: '(^|/)src/auth/' },
      to: { path: '(^|/)src/(products|orders|files)/' },
    },
    {
      name: 'messaging-not-to-outbox',
      severity: 'error',
      comment: 'outbox публікує через messaging; зворотний імпорт ламає шар (брокер не знає про таблицю outbox)',
      from: { path: '(^|/)src/messaging/' },
      to: { path: '(^|/)src/outbox/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'цикли між файлами. Крім src/entities: двосторонні звʼязки TypeORM (order <-> order_item) — цикл за задумом ORM',
      from: { pathNot: '(^|/)src/entities/' },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    // tsConfig не вказуємо: фікстура лежить поза include основного tsconfig
  },
};
