import React from 'react';

type IconProps = {
  className?: string;
};

const svgProps = {
  width: '1em',
  height: '1em',
  viewBox: '0 0 12 12',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true as const,
  focusable: false as const,
};

/** Thin-line Windows caption icons matching the custom titlebar reference art. */
export function TitleBarMinimizeIcon({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path
        d="M2.25 6h7.5"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TitleBarMaximizeIcon({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <rect
        x="2.35"
        y="2.35"
        width="7.3"
        height="7.3"
        rx="1.35"
        ry="1.35"
        stroke="currentColor"
        strokeWidth="1.15"
      />
    </svg>
  );
}

export function TitleBarRestoreIcon({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      {/* Rear square (upper-right) */}
      <rect
        x="3.85"
        y="1.9"
        width="6.1"
        height="6.1"
        rx="1.2"
        ry="1.2"
        stroke="currentColor"
        strokeWidth="1.15"
      />
      {/* Front square (lower-left); opaque fill hides the rear edge under it */}
      <rect
        className="titlebar-window-control-restore-front"
        x="1.9"
        y="3.85"
        width="6.1"
        height="6.1"
        rx="1.2"
        ry="1.2"
        stroke="currentColor"
        strokeWidth="1.15"
      />
    </svg>
  );
}

export function TitleBarCloseIcon({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path
        d="M3.1 3.1l5.8 5.8M8.9 3.1l-5.8 5.8"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function resolveTitleBarWindowToggleIcon(kind: 'maximize' | 'restore') {
  return kind === 'restore' ? <TitleBarRestoreIcon /> : <TitleBarMaximizeIcon />;
}
