import { getDataSourceSpec } from './index';

/** 描述表声明的表设计器索引限制（ui.indexDesign）：可建的索引类别与索引方法，方法列表首项为默认方法。 */
export type RegistryIndexDesign = {
  kinds: string[];
  methods: string[];
};

/** 返回连接类型的索引限制；未声明或不是描述表类型时返回 undefined，沿用借用方言的规则。 */
export const getRegistryIndexDesign = (type: unknown): RegistryIndexDesign | undefined => {
  const design = getDataSourceSpec(type)?.ui?.indexDesign;
  if (!design?.methods?.length) return undefined;
  return { kinds: design.kinds ?? [], methods: design.methods };
};

/** 按索引限制过滤索引类别选项（未声明 kinds 时原样返回）。 */
export const filterIndexKindsByDesign = <T extends { value: string }>(
  options: T[],
  design: RegistryIndexDesign | undefined,
): T[] => (design?.kinds.length ? options.filter((option) => design.kinds.includes(option.value)) : options);
