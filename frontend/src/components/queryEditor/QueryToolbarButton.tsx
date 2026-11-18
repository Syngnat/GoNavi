import React, { useRef } from 'react';
import { Button } from 'antd';

type QueryToolbarButtonProps = React.ComponentProps<typeof Button>;

const ACTIVATE_DEDUPE_MS = 400;

// macOS 27.2 的 WebKit 经常把按钮的 click 丢掉，mousedown/pointerup 还在。
// 按下松开都走同一条动作，并在短时间内去重，避免正常浏览器点一次执行两次。
export const QueryToolbarButton = React.forwardRef<HTMLButtonElement, QueryToolbarButtonProps>(
  function QueryToolbarButton({ onClick, onPointerUp, disabled, ...rest }, ref) {
    const lastActivatedAt = useRef(0);
    const activate = (event: React.MouseEvent<HTMLElement> | React.PointerEvent<HTMLElement>) => {
      if (disabled) return;
      const now = performance.now();
      if (now - lastActivatedAt.current < ACTIVATE_DEDUPE_MS) return;
      lastActivatedAt.current = now;
      onClick?.(event as React.MouseEvent<HTMLElement>);
    };

    return (
      <Button
        {...rest}
        disabled={disabled}
        ref={ref}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          if (event.button !== 0) return;
          activate(event);
        }}
        onClick={(event) => activate(event)}
      />
    );
  },
);
