import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NacosHistoryDetailModal from './NacosHistoryDetailModal';
vi.mock('antd', () => ({
  Modal: ({children, ...props}: any) => <div data-modal="true" {...props}>{children}</div>,
  Button: ({children, ...props}: any) => <button {...props}>{children}</button>,
  Space: ({children}: any) => <span>{children}</span>,
  Tag: ({children}: any) => <span>{children}</span>,
  Spin: () => <span />,
  Popconfirm: ({children}: any) => <span>{children}</span>,
}));
vi.mock('./MonacoEditor', () => ({ default: (props: any) => <div data-history-editor={true} {...props} /> }));
vi.mock('./nacos/NacosHistoryDiff', () => ({ default: (props: any) => <div data-diff={true} {...props} /> }));
const tr = (key: string) => key;
const history = {id:'1',dataId:'app.yaml',group:'G',content:'port: 8080'};
const deferred = () => { let resolve!: (value:string)=>void; let reject!: (error:Error)=>void; const promise = new Promise<string>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));
const props = {open:true,loading:false,history,currentConfig:{dataId:'app.yaml',group:'G'},language:'yaml',readOnly:false,rollingBack:false,onClose:vi.fn(),onRollback:vi.fn(),tr};
const compareButton=()=>renderer.root.findAllByType('button').find(n=>n.children.includes('nacos.history.compare_current'))!;
describe('Nacos history comparison',()=>{
  it('fetches current published content on demand and preserves historical original',async()=>{
    const loadCurrentContent=vi.fn().mockResolvedValue('port: 9090');
    act(()=>{renderer=create(<NacosHistoryDetailModal {...props} loadCurrentContent={loadCurrentContent}/>);});
    await act(async()=>compareButton().props.onClick());
    expect(loadCurrentContent).toHaveBeenCalledWith(history);
    expect(renderer.root.findByProps({'data-diff':true}).props).toMatchObject({original:'port: 8080',modified:'port: 9090',language:'yaml'});
    expect(props.onRollback).not.toHaveBeenCalled();
  });
  it('rejects a stale current response after closing or changing history',async()=>{
    const pending=deferred();
    act(()=>{renderer=create(<NacosHistoryDetailModal {...props} loadCurrentContent={()=>pending.promise}/>);});
    act(()=>compareButton().props.onClick());
    act(()=>renderer.update(<NacosHistoryDetailModal {...props} open={false} history={{...history,id:'2',content:'new history'}} loadCurrentContent={()=>pending.promise}/>));
    await act(async()=>pending.resolve('stale'));
    expect(renderer.root.findAllByProps({'data-diff':true})).toHaveLength(0);
  });
  it('shows a failed current fetch and leaves history intact',async()=>{
    act(()=>{renderer=create(<NacosHistoryDetailModal {...props} loadCurrentContent={async()=>{throw Error('denied');}}/>);});
    await act(async()=>compareButton().props.onClick());
    expect(renderer.root.findByProps({role:'alert'}).children).toEqual(['denied']);
    expect(renderer.root.findByProps({'data-history-editor':true}).props.value).toBe(history.content);
  });
});
