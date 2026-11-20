import React, { useEffect, useId, useRef } from 'react';
import { WarningOutlined } from '@ant-design/icons';

interface ScriptWorkbenchConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  cancelLabel: string;
  confirmLabel: string;
  danger?: boolean;
  testId?: string;
  onResolve: (confirmed: boolean) => void;
  children?: React.ReactNode;
}

export const ScriptWorkbenchConfirmDialog: React.FC<ScriptWorkbenchConfirmDialogProps> = ({
  open,
  title,
  description,
  cancelLabel,
  confirmLabel,
  danger = false,
  testId,
  onResolve,
  children,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resolvedRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      resolvedRef.current = false;
      dialog.returnValue = '';
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close('');
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const handleClose = () => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      const confirmed = dialog.returnValue === 'confirm';
      dialog.returnValue = '';
      onResolve(confirmed);
    };
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onResolve]);

  return (
    <dialog
      ref={dialogRef}
      className="gn-script-dialog"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-testid={testId}
    >
      <form method="dialog">
        <div className="gn-script-dialog-heading">
          <span className={`gn-script-dialog-symbol${danger ? ' is-danger' : ''}`} aria-hidden="true">
            <WarningOutlined />
          </span>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
        </div>
        {children ? <div className="gn-script-dialog-content">{children}</div> : null}
        <div className="gn-script-dialog-actions">
          <button type="submit" value="cancel" className="gn-script-button" autoFocus>
            {cancelLabel}
          </button>
          <button
            type="submit"
            value="confirm"
            className={`gn-script-button${danger ? ' gn-script-button--danger' : ' gn-script-button--primary'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
};
