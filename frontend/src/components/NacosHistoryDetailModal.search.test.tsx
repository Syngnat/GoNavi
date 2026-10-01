import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import NacosHistoryDetailModal from './NacosHistoryDetailModal';
vi.mock('antd',()=>({
  Modal:({children,...props}:any)=><div data-modal={true} {...props}>{children}</div>,
  Button:({children,...props}:any)=><button {...props}>{children}</button>,
  Space:({children}:any)=><span>{children}</span>, Tag:({children}:any)=><span>{children}</span>,
  Spin:()=> <span/>, Popconfirm:({children}:any)=><span>{children}</span>,
}));
vi.mock('./MonacoEditor',()=>({default:(props:any)=><div data-editor={true} {...props}/>}));
vi.mock('./nacos/NacosHistoryDiff',()=>({default:(props:any)=><div data-diff={true} {...props}/>}));
const history={id:'1',dataId:'a.yaml',group:'G',content:'a: 1'};
const props={open:true,loading:false,history,currentConfig:history,language:'yaml',readOnly:false,rollingBack:false,onClose:vi.fn(),onRollback:vi.fn(),tr:(k:string)=>k,loadCurrentContent:async()=> 'a: 2'};
const event=(meta=false)=>({ctrlKey:!meta,metaKey:meta,altKey:false,key:'f',preventDefault:vi.fn(),stopPropagation:vi.fn()});
const dispatch=(renderer:ReactTestRenderer,e:ReturnType<typeof event>)=>renderer.root.findByProps({'data-modal':true}).props.modalRender(<span/>).props.onKeyDownCapture(e);
describe('Nacos history search shortcut',()=>{
  it.each([false,true])('opens read-only history search for Ctrl/Cmd+F (meta=%s)',meta=>{
    let renderer!:ReactTestRenderer;act(()=>{renderer=create(<NacosHistoryDetailModal {...props}/>);});
    const editor={focus:vi.fn(),trigger:vi.fn()};
    renderer.root.findByProps({'data-editor':true}).props.onMount(editor);
    const e=event(meta);dispatch(renderer,e);
    expect(e.preventDefault).toHaveBeenCalled();expect(e.stopPropagation).toHaveBeenCalled();
    expect(editor.trigger).toHaveBeenCalledWith('nacos-history','actions.find',null);
    act(()=>renderer.unmount());
  });
  it('searches the focused history side in diff mode',async()=>{
    let renderer!:ReactTestRenderer;act(()=>{renderer=create(<NacosHistoryDetailModal {...props}/>);});
    const button=renderer.root.findAllByType('button').find(n=>n.children.includes('nacos.history.compare_current'))!;
    await act(async()=>button.props.onClick());
    const original={hasWidgetFocus:()=>true,focus:vi.fn(),trigger:vi.fn()};const modified={focus:vi.fn(),trigger:vi.fn()};
    renderer.root.findByProps({'data-diff':true}).props.onMount({getOriginalEditor:()=>original,getModifiedEditor:()=>modified});
    dispatch(renderer,event());expect(original.trigger).toHaveBeenCalled();expect(modified.trigger).not.toHaveBeenCalled();
    act(()=>renderer.unmount());
  });
});
