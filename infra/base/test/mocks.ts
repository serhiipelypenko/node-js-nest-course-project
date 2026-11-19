// Спільні моки Pulumi: жодного AWS, жодного бекенда. Кожен newResource записується
// в масив у порядку реєстрації — з цього порядку тест «бюджет першим» і читає.
import * as pulumi from "@pulumi/pulumi";

export interface Rec { type: string; name: string; inputs: any }

export function installMocks(stack: string): Rec[] {
  const recs: Rec[] = [];
  pulumi.runtime.setMocks({
    newResource(args: pulumi.runtime.MockResourceArgs) {
      recs.push({ type: args.type, name: args.name, inputs: args.inputs });
      return {
        id: `${args.name}-id`,
        state: { ...args.inputs, arn: `arn:aws:mock:::${args.name}`, name: args.inputs.name ?? args.name },
      };
    },
    call(args: pulumi.runtime.MockCallArgs) { return args.inputs; },
  }, "hw31", stack, false);
  return recs;
}

// Дочекатись, поки всі Output розвʼяжуться і реєстрації доїдуть до моків.
export async function settle(outputs: pulumi.Output<unknown>[]) {
  await new Promise<void>((resolve) => pulumi.all(outputs).apply(() => resolve()));
  await new Promise((r) => setTimeout(r, 50));
}

export const byType = (recs: Rec[], t: string) => recs.filter((r) => r.type === t);
