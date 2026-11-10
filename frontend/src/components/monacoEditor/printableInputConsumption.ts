/**
 * 可打印输入「已被编辑器消费、但文本没有变化」的判定。
 *
 * 背景：Monaco 的自动配对会把某些按键吃掉而不改动文本。典型场景是自动补全括号：
 * 输入左括号后编辑器补出右括号，此时再输入右括号，Monaco 直接把光标移到右括号之后，
 * 文本保持不变（没有多出第二个右括号）。
 *
 * 输入兜底逻辑（printableInputFallback）原本靠「文本是否变化」判断原生输入有没有生效，
 * 于是把这种「文本没变、光标右移」的输入误判成原生输入丢失，又把字符回放一次，
 * 结果就是右括号重复、用户还得手动删。
 *
 * 这里单独抽出判定：文本长度与输入前完全一致、且光标正好前进了输入长度，
 * 说明编辑器已经消费了这次输入，绝不能再回放。只读取光标处的单个字符，
 * 不复制整篇文档。
 */
export interface PrintableInputConsumptionSnapshot {
  /** 输入发生前的文档长度。 */
  valueLengthBefore: number;
  /** 输入发生前光标所在的字符偏移量。 */
  offsetBefore: number;
  /** 本次输入的字符。 */
  text: string;
}

export const isPrintableInputConsumedWithoutTextChange = (
  pending: PrintableInputConsumptionSnapshot,
  currentValueLength: number,
  currentOffset: number | undefined,
  readTextAtOffset: (offset: number) => string,
): boolean => {
  if (currentValueLength !== pending.valueLengthBefore) {
    return false;
  }
  if (typeof currentOffset !== 'number' || !Number.isFinite(currentOffset)) {
    return false;
  }
  if (currentOffset !== pending.offsetBefore + pending.text.length) {
    return false;
  }
  if (pending.text.length !== 1) {
    return false;
  }
  // 编辑器是「把光标处的同一个字符原地重写」了一次（Monaco 跳过已补出的右括号就是这样），
  // 因此光标位置上的字符必须与输入字符一致；否则只是光标被别处移动过，输入仍然丢了。
  return readTextAtOffset(pending.offsetBefore) === pending.text;
};