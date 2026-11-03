import React from 'react';
import MonacoEditor from '../MonacoEditor';

type Props = {
  language: string;
  value: string;
  onChange: (value: string) => void;
  height?: number;
};

// GLUE 源码编辑器：复用仓库统一的 Monaco 包装（主题、剪贴板、IME 已处理），
// 按 glueType 切换语言。
// 挂载后主动触发一次 relayout：表单里条件渲染的编辑器在挂载瞬间容器可能
// 尚未展开（测得 5px），Monaco 的 automaticLayout 不一定捕捉到随后的展开。
export const XxlJobGlueEditor: React.FC<Props> = ({ language, value, onChange, height = 320 }) => (
  <MonacoEditor
    height={height}
    language={language}
    value={value}
    onChange={(next) => onChange(next ?? '')}
    onMount={(editor) => {
      // 首帧后强制重算布局，避免塌陷成初始 5px。
      window.setTimeout(() => editor.layout(), 50);
      window.setTimeout(() => editor.layout(), 300);
    }}
    options={{
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 4,
      wordWrap: 'on',
    }}
  />
);

export default XxlJobGlueEditor;
