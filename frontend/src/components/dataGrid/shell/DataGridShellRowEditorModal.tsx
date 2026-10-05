import { Button, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import Modal from '../../common/ResizableDraggableModal';
import type { DataGridShellProps } from '../../DataGridShell';

export interface DataGridShellRowEditorModalProps {
  translateDataGrid: DataGridShellProps['translateDataGrid'];
  previewModalOpen: DataGridShellProps['previewModalOpen'];
  setPreviewModalOpen: DataGridShellProps['setPreviewModalOpen'];
  previewSqlData: DataGridShellProps['previewSqlData'];
  darkMode: DataGridShellProps['darkMode'];
}

export const DataGridShellRowEditorModal = ({
  translateDataGrid, previewModalOpen, setPreviewModalOpen, previewSqlData, darkMode,
}: DataGridShellRowEditorModalProps) => (
  <Modal
      title={translateDataGrid('data_grid.preview_sql.title')}
      open={previewModalOpen}
      onCancel={() => setPreviewModalOpen(false)}
      width={800}
      footer={null}
  >
      <div style={{ marginBottom: 16 }}>
          {previewSqlData.deletes.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 'bold', color: '#ff4d4f', marginBottom: 8 }}>
                      DELETE ({previewSqlData.deletes.length})
                  </div>
                   {previewSqlData.deletes.map((sql: string, i: number) => (
                      <div key={`del-${i}`} style={{ position: 'relative', marginBottom: 8 }}>
                          <pre style={{
                              background: darkMode ? 'rgba(255, 77, 79, 0.10)' : '#fff2f0',
                              border: darkMode ? '1px solid rgba(255, 77, 79, 0.25)' : '1px solid #ffccc7',
                              padding: '8px 40px 8px 12px', borderRadius: 4,
                              fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                              margin: 0,
                          }}>{sql}</pre>
                          <Button
                              size="small" type="text"
                              icon={<CopyOutlined />}
                              style={{ position: 'absolute', top: 4, right: 4 }}
                              onClick={() => { navigator.clipboard.writeText(sql).then(() => message.success(translateDataGrid('data_grid.preview_sql.copied'))); }}
                          />
                      </div>
                  ))}
              </div>
          )}
          {previewSqlData.updates.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 'bold', color: '#fa8c16', marginBottom: 8 }}>
                      UPDATE ({previewSqlData.updates.length})
                  </div>
                   {previewSqlData.updates.map((sql: string, i: number) => (
                      <div key={`upd-${i}`} style={{ position: 'relative', marginBottom: 8 }}>
                          <pre style={{
                              background: darkMode ? 'rgba(250, 140, 22, 0.10)' : '#fff7e6',
                              border: darkMode ? '1px solid rgba(250, 140, 22, 0.25)' : '1px solid #ffd591',
                              padding: '8px 40px 8px 12px', borderRadius: 4,
                              fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                              margin: 0,
                          }}>{sql}</pre>
                          <Button
                              size="small" type="text"
                              icon={<CopyOutlined />}
                              style={{ position: 'absolute', top: 4, right: 4 }}
                              onClick={() => { navigator.clipboard.writeText(sql).then(() => message.success(translateDataGrid('data_grid.preview_sql.copied'))); }}
                          />
                      </div>
                  ))}
              </div>
          )}
          {previewSqlData.inserts.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 'bold', color: '#52c41a', marginBottom: 8 }}>
                      INSERT ({previewSqlData.inserts.length})
                  </div>
                   {previewSqlData.inserts.map((sql: string, i: number) => (
                      <div key={`ins-${i}`} style={{ position: 'relative', marginBottom: 8 }}>
                          <pre style={{
                              background: darkMode ? 'rgba(82, 196, 26, 0.10)' : '#f6ffed',
                              border: darkMode ? '1px solid rgba(82, 196, 26, 0.25)' : '1px solid #b7eb8f',
                              padding: '8px 40px 8px 12px', borderRadius: 4,
                              fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                              margin: 0,
                          }}>{sql}</pre>
                          <Button
                              size="small" type="text"
                              icon={<CopyOutlined />}
                              style={{ position: 'absolute', top: 4, right: 4 }}
                              onClick={() => { navigator.clipboard.writeText(sql).then(() => message.success(translateDataGrid('data_grid.preview_sql.copied'))); }}
                          />
                      </div>
                  ))}
              </div>
          )}
          {previewSqlData.deletes.length === 0 && previewSqlData.updates.length === 0 && previewSqlData.inserts.length === 0 && (
              <div style={{ color: darkMode ? '#888' : '#999', textAlign: 'center', padding: 24 }}>
                  {translateDataGrid('data_grid.preview_sql.no_changes')}
              </div>
          )}
      </div>
      <div style={{ color: darkMode ? '#999' : '#888', fontSize: 12, borderTop: darkMode ? '1px solid #303030' : '1px solid #f0f0f0', paddingTop: 8 }}>
          {translateDataGrid('data_grid.preview_sql.summary', {
              deletes: previewSqlData.deletes.length,
              updates: previewSqlData.updates.length,
              inserts: previewSqlData.inserts.length
          })}
      </div>
  </Modal>
);
