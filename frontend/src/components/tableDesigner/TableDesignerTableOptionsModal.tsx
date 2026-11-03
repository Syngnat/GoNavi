import { Modal, Select } from 'antd';

type Props = {
  open: boolean;
  charset: string;
  collation: string;
  charsetOptions: { label: string; value: string }[];
  collationOptions: Record<string, { label: string; value: string }[]>;
  /** 表当前生效的排序规则，用于提示「未改动」。 */
  currentCollation: string;
  disabled: boolean;
  titleText: string;
  charsetLabel: string;
  collationLabel: string;
  warningText: string;
  onChangeCharset: (charset: string) => void;
  onChangeCollation: (collation: string) => void;
  onClose: () => void;
  t: (key: string, params?: Record<string, string | number>, lang?: string) => string;
  i18nLanguage: string;
};

/**
 * 表选项弹窗：编辑已有表时改表级字符集与排序规则。
 *
 * 单独成弹窗而不是塞进工具栏：编辑态工具栏已经放了保存/刷新/表注释/加列/
 * 复制列等按钮，再加两个下拉会挤到换行。
 */
export function TableDesignerTableOptionsModal({
  open, charset, collation, charsetOptions, collationOptions, currentCollation,
  disabled, titleText, charsetLabel, collationLabel, warningText,
  onChangeCharset, onChangeCollation, onClose, t, i18nLanguage,
}: Props) {
  const dirty = Boolean(collation) && collation !== currentCollation;
  return (
    <Modal
      open={open}
      title={titleText}
      okText={t('common.ok', undefined, i18nLanguage)}
      cancelText={t('common.cancel', undefined, i18nLanguage)}
      onCancel={onClose}
      onOk={onClose}
      destroyOnHidden
    >
      <div className="gn-designer-table-options" data-designer-table-options="true">
        <label className="gn-designer-table-options__row">
          <span>{charsetLabel}</span>
          <Select
            value={charset || undefined}
            disabled={disabled}
            options={charsetOptions}
            style={{ width: 180 }}
            onChange={(value) => {
              onChangeCharset(value);
              // 换字符集后原排序规则多半已经不可用，取新字符集的第一个。
              const next = collationOptions[value]?.[0]?.value;
              if (next) onChangeCollation(next);
            }}
          />
        </label>
        <label className="gn-designer-table-options__row">
          <span>{collationLabel}</span>
          <Select
            value={collation || undefined}
            disabled={disabled}
            options={collationOptions[charset] || []}
            style={{ width: 240 }}
            onChange={onChangeCollation}
          />
        </label>
        {dirty ? (
          <p className="gn-designer-table-options__warning" role="note">
            {warningText}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
