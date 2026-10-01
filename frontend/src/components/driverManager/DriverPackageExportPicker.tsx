import { Alert, Button, Checkbox, Modal } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { t } from '../../i18n';
import './DriverPackageExportPicker.css';

export type DriverPackageExportChoice = {
  type: string;
  name: string;
  version?: string;
};

export type DriverPackageExportPickerProps = {
  open: boolean;
  drivers: DriverPackageExportChoice[];
  onConfirm: (driverTypes: string[]) => void;
  onCancel: () => void;
};

export default function DriverPackageExportPicker({
  open,
  drivers,
  onConfirm,
  onCancel,
}: DriverPackageExportPickerProps) {
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setSelected([]);
    }
  }, [open]);

  const allTypes = useMemo(() => drivers.map((driver) => driver.type), [drivers]);
  const allChecked = allTypes.length > 0 && selected.length === allTypes.length;
  const confirmLabel = selected.length === 0
    ? t('driver_manager.export.pick_confirm_all')
    : t('driver_manager.export.pick_confirm_selected', { count: selected.length });

  return (
    <Modal
      open={open}
      title={t('driver_manager.export.pick_title')}
      onCancel={onCancel}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onCancel}>
          {t('driver_manager.export.pick_cancel')}
        </Button>,
        <Button
          key="ok"
          type="primary"
          disabled={drivers.length === 0}
          onClick={() => onConfirm(selected)}
        >
          {confirmLabel}
        </Button>,
      ]}
    >
      <Alert type="info" showIcon message={t('driver_manager.export.pick_hint')} />
      <div className="gn-driver-export-picker">
        <Checkbox
          indeterminate={selected.length > 0 && !allChecked}
          checked={allChecked}
          disabled={drivers.length === 0}
          onChange={(event) => setSelected(event.target.checked ? allTypes : [])}
        >
          {t('driver_manager.export.pick_select_all')}
        </Checkbox>
        <Checkbox.Group
          className="gn-driver-export-picker-list"
          value={selected}
          onChange={(values) => setSelected(values.map((value) => String(value)))}
        >
          {drivers.map((driver) => (
            <Checkbox key={driver.type} value={driver.type}>
              <span>{driver.name || driver.type}</span>
              {driver.version ? (
                <span className="gn-driver-export-picker-version">
                  {t('driver_manager.export.pick_version', { version: driver.version })}
                </span>
              ) : null}
            </Checkbox>
          ))}
        </Checkbox.Group>
      </div>
    </Modal>
  );
}
