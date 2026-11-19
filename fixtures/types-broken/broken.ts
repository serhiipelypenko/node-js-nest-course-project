// Фікстура demo:gates: зумисна одруковка в типі (сходинка 1). tsc ловить TS2322, eslint — невикористану змінну.
const total: number = 'не число';
const unused = 1;

export function price(): number {
  return total;
}
