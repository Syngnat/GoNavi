import React, { useState, useEffect } from 'react';
import { Layout, Button, ConfigProvider, theme } from 'antd';
import { PlusOutlined, BulbOutlined, BulbFilled } from '@ant-design/icons';
import Sidebar from './components/Sidebar';
import TabManager from './components/TabManager';
import ConnectionModal from './components/ConnectionModal';
import { useStore } from './store';
import './App.css';

const { Sider, Content } = Layout;

function App() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { darkMode, toggleDarkMode } = useStore();
  
  // Sidebar Resizing
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const sidebarDragRef = React.useRef<{ startX: number, startWidth: number } | null>(null);

  const handleSidebarMouseDown = (e: React.MouseEvent) => {
      e.preventDefault();
      sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
      document.addEventListener('mousemove', handleSidebarMouseMove);
      document.addEventListener('mouseup', handleSidebarMouseUp);
  };

  const handleSidebarMouseMove = (e: MouseEvent) => {
      if (!sidebarDragRef.current) return;
      const delta = e.clientX - sidebarDragRef.current.startX;
      const newWidth = Math.max(200, Math.min(600, sidebarDragRef.current.startWidth + delta));
      setSidebarWidth(newWidth);
  };

  const handleSidebarMouseUp = () => {
      sidebarDragRef.current = null;
      document.removeEventListener('mousemove', handleSidebarMouseMove);
      document.removeEventListener('mouseup', handleSidebarMouseUp);
  };

  useEffect(() => {
    if (darkMode) {
        document.body.style.backgroundColor = '#141414';
        document.body.style.color = '#ffffff';
    } else {
        document.body.style.backgroundColor = '#ffffff';
        document.body.style.color = '#000000';
    }
  }, [darkMode]);

  return (
    <ConfigProvider
        theme={{
            algorithm: darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
        }}
    >
        <Layout style={{ height: '100vh' }}>
          <Sider theme={darkMode ? "dark" : "light"} width={sidebarWidth} style={{ borderRight: darkMode ? '1px solid #303030' : '1px solid #f0f0f0', position: 'relative' }}>
            <div style={{ padding: '10px', borderBottom: darkMode ? '1px solid #303030' : '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 'bold', paddingLeft: 8 }}>GoNavi</span>
              <div>
                  <Button type="text" icon={darkMode ? <BulbFilled /> : <BulbOutlined />} onClick={toggleDarkMode} title="切换主题" />
                  <Button type="text" icon={<PlusOutlined />} onClick={() => setIsModalOpen(true)} title="新建连接" />
              </div>
            </div>
            <Sidebar />
            
            {/* Sidebar Resize Handle */}
            <div 
                onMouseDown={handleSidebarMouseDown}
                style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: '5px',
                    cursor: 'col-resize',
                    zIndex: 100,
                    // background: 'transparent' // transparent usually, visible on hover if desired
                }}
                title="拖动调整宽度"
            />
          </Sider>
          <Content style={{ background: darkMode ? '#141414' : '#fff' }}>
            <TabManager />
          </Content>
          <ConnectionModal open={isModalOpen} onClose={() => setIsModalOpen(false)} />
        </Layout>
    </ConfigProvider>
  );
}

export default App;