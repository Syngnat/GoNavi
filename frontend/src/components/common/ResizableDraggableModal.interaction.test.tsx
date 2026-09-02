import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('antd', async () => {
  const ReactModule = await import('react');
  const modalResult = () => ({ update: vi.fn() });
  const modalApi = {
    info: modalResult,
    success: modalResult,
    error: modalResult,
    warning: modalResult,
    confirm: modalResult,
  };
  const Modal = Object.assign(
    ({ children }: { children?: React.ReactNode }) => ReactModule.createElement(ReactModule.Fragment, null, children),
    {
      ...modalApi,
      destroyAll: vi.fn(),
      useModal: () => [modalApi, null],
    },
  );
  return { Modal };
});

import { DraggableResizableModalFrame } from './ResizableDraggableModal';

type Listener = (event: any) => void;

class FakeEventTarget {
  private listeners = new Map<string, Array<{ listener: Listener; once: boolean }>>();

  addEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: typeof options === 'object' && options.once === true });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener));
  }

  dispatch(type: string, event: any = {}) {
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      if (entry.once) {
        this.removeEventListener(type, entry.listener);
      }
      entry.listener(event);
    }
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.length ?? 0;
  }
}

class FakeHTMLElement extends FakeEventTarget {
  classList: { contains: (className: string) => boolean };
  style = Object.assign({ width: '' }, {
    removeProperty: (property: string) => {
      if (property === 'width') this.style.width = '';
    },
  });

  constructor(
    private readonly kind: 'wrapper' | 'modal' | 'content' | 'header' | 'resize-handle',
    private readonly classes: string[] = [],
  ) {
    super();
    this.classList = { contains: (className) => this.classes.includes(className) };
  }

  modal: FakeHTMLElement | null = null;
  content: FakeHTMLElement | null = null;

  closest(selector: string) {
    if (this.kind === 'wrapper' && selector === '.ant-modal') return this.modal;
    if (this.kind === 'header' && selector.includes('.ant-modal-header')) return this;
    if (this.kind === 'resize-handle' && selector === '.gn-modal-resize-handle') return this;
    return null;
  }

  querySelector(selector: string) {
    return this.kind === 'wrapper' && selector === '.ant-modal-content' ? this.content : null;
  }

  getBoundingClientRect() {
    if (this.kind === 'content') {
      return { top: 100, right: 800, bottom: 600, left: 200, width: 600, height: 500 };
    }
    return { top: 100, right: 800, bottom: 600, left: 200, width: 600, height: 500 };
  }
}

describe('DraggableResizableModalFrame interaction cleanup', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousHTMLElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  let fakeWindow: FakeEventTarget & { innerWidth: number; innerHeight: number; setTimeout: typeof setTimeout };
  let wrapper: FakeHTMLElement;
  let header: FakeHTMLElement;
  let resizeHandle: FakeHTMLElement;
  let renderer: ReactTestRenderer | null = null;

  const mount = (active = true) => {
    renderer = create(
      <DraggableResizableModalFrame
        active={active}
        draggable
        resizable
        minResizableWidth={360}
        minResizableHeight={220}
      >
        <span>content</span>
      </DraggableResizableModalFrame>,
      { createNodeMock: () => wrapper },
    );
  };

  const pointerEvent = (target: FakeHTMLElement, buttons = 1) => ({
    button: 0,
    buttons,
    clientX: 400,
    clientY: 300,
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });

  const frameProps = () => renderer?.root.findByProps({ 'data-draggable': 'true' }).props;

  beforeEach(() => {
    vi.useFakeTimers();
    const modal = new FakeHTMLElement('modal');
    const content = new FakeHTMLElement('content');
    wrapper = new FakeHTMLElement('wrapper');
    wrapper.modal = modal;
    wrapper.content = content;
    header = new FakeHTMLElement('header');
    resizeHandle = new FakeHTMLElement('resize-handle', ['gn-modal-resize-handle-south-east']);
    fakeWindow = Object.assign(new FakeEventTarget(), {
      innerWidth: 1200,
      innerHeight: 900,
      setTimeout: globalThis.setTimeout,
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeHTMLElement });

    act(() => mount());
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    if (previousHTMLElementDescriptor) {
      Object.defineProperty(globalThis, 'HTMLElement', previousHTMLElementDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'HTMLElement');
    }
  });

  it('aborts a drag on blur without suppressing the next click and allows another drag', () => {
    act(() => wrapper.dispatch('pointerdown', pointerEvent(header)));
    expect(frameProps()?.['data-dragging']).toBe('true');

    act(() => fakeWindow.dispatch('blur'));

    expect(frameProps()?.['data-dragging']).toBe('false');
    expect(fakeWindow.listenerCount('pointermove')).toBe(0);
    expect(fakeWindow.listenerCount('mousemove')).toBe(0);
    expect(fakeWindow.listenerCount('click')).toBe(0);
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    fakeWindow.dispatch('click', click);
    expect(click.preventDefault).not.toHaveBeenCalled();

    act(() => wrapper.dispatch('pointerdown', pointerEvent(header)));
    expect(frameProps()?.['data-dragging']).toBe('true');
  });

  it('aborts resize when a move reports no pressed buttons', () => {
    act(() => wrapper.dispatch('pointerdown', pointerEvent(resizeHandle)));
    expect(frameProps()?.['data-resizing']).toBe('true');

    act(() => fakeWindow.dispatch('pointermove', pointerEvent(resizeHandle, 0)));

    expect(frameProps()?.['data-resizing']).toBe('false');
    expect(fakeWindow.listenerCount('pointermove')).toBe(0);
    expect(fakeWindow.listenerCount('mousemove')).toBe(0);
    expect(fakeWindow.listenerCount('click')).toBe(0);
  });

  it('cleans an active interaction when the frame closes or unmounts', () => {
    act(() => wrapper.dispatch('pointerdown', pointerEvent(header)));

    act(() => {
      renderer?.update(
        <DraggableResizableModalFrame
          active={false}
          draggable
          resizable
          minResizableWidth={360}
          minResizableHeight={220}
        >
          <span>content</span>
        </DraggableResizableModalFrame>,
      );
    });
    expect(fakeWindow.listenerCount('pointermove')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);

    act(() => renderer?.unmount());
    renderer = null;
    expect(fakeWindow.listenerCount('pointermove')).toBe(0);
    expect(fakeWindow.listenerCount('click')).toBe(0);
  });

  // Regression: the settings/tool centre passes a fixed `height` through antd
  // `styles.content`, so a south drag has to publish a resized height of its own and
  // must not silently freeze the width it never touched.
  it('resizes height from the south handle without pinning width', () => {
    const southHandle = new FakeHTMLElement('resize-handle', ['gn-modal-resize-handle-south']);

    act(() => wrapper.dispatch('pointerdown', pointerEvent(southHandle)));
    act(() => fakeWindow.dispatch('pointermove', { ...pointerEvent(southHandle), clientY: 420 }));

    expect(frameProps()?.['data-has-resized-height']).toBe('true');
    expect(frameProps()?.style['--gn-modal-resized-height']).toBe('620px');
    expect(frameProps()?.['data-has-resized-width']).toBe('false');
    expect(frameProps()?.style['--gn-modal-resized-width']).toBeUndefined();
  });

  it('resizes width from the east handle without pinning height', () => {
    const eastHandle = new FakeHTMLElement('resize-handle', ['gn-modal-resize-handle-east']);

    act(() => wrapper.dispatch('pointerdown', pointerEvent(eastHandle)));
    act(() => fakeWindow.dispatch('pointermove', { ...pointerEvent(eastHandle), clientX: 550 }));

    expect(frameProps()?.['data-has-resized-width']).toBe('true');
    expect(frameProps()?.style['--gn-modal-resized-width']).toBe('750px');
    expect(frameProps()?.['data-has-resized-height']).toBe('false');
    expect(frameProps()?.style['--gn-modal-resized-height']).toBeUndefined();
  });

  it('resizes both axes from the south-east handle', () => {
    act(() => wrapper.dispatch('pointerdown', pointerEvent(resizeHandle)));
    act(() => fakeWindow.dispatch('pointermove', { ...pointerEvent(resizeHandle), clientX: 500, clientY: 400 }));

    expect(frameProps()?.style['--gn-modal-resized-width']).toBe('700px');
    expect(frameProps()?.style['--gn-modal-resized-height']).toBe('600px');
  });

  it('suppresses only the synthetic click after a completed interaction', () => {
    act(() => wrapper.dispatch('pointerdown', pointerEvent(header)));
    act(() => fakeWindow.dispatch('pointerup'));

    expect(fakeWindow.listenerCount('click')).toBe(1);
    const syntheticClick = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    fakeWindow.dispatch('click', syntheticClick);
    expect(syntheticClick.preventDefault).toHaveBeenCalledOnce();

    const nextClick = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    fakeWindow.dispatch('click', nextClick);
    expect(nextClick.preventDefault).not.toHaveBeenCalled();
  });
});
