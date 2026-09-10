import React from 'react';
import { BRAND_ICONS, resolveBrandIconSrc, type BrandIconId } from '../brand/brandIcons';

type BrandIconPickerProps = {
  value: string;
  onChange: (id: BrandIconId) => void;
  darkMode?: boolean;
  accentColor?: string;
  ariaLabel?: string;
};

export default function BrandIconPicker({ value, onChange, darkMode = false, accentColor = '#16a34a', ariaLabel = 'GoNavi brand icon' }: BrandIconPickerProps) {
  const border = darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(16,24,40,0.12)';
  const muted = darkMode ? 'rgba(255,255,255,0.55)' : 'rgba(16,24,40,0.55)';
  const title = darkMode ? 'rgba(255,255,255,0.88)' : 'rgba(16,24,40,0.88)';

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        columnGap: 14,
        rowGap: 0,
        borderTop: `1px solid ${border}`,
      }}
    >
      {BRAND_ICONS.map((item, itemIndex) => {
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                return;
              }
              event.preventDefault();
              const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? BRAND_ICONS.length - 1
                  : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                    ? (itemIndex + 1) % BRAND_ICONS.length
                    : (itemIndex - 1 + BRAND_ICONS.length) % BRAND_ICONS.length;
              onChange(BRAND_ICONS[nextIndex].id);
              const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
              radios?.[nextIndex]?.focus();
            }}
            style={{
              appearance: 'none',
              cursor: 'pointer',
              border: 'none',
              borderLeft: `3px solid ${active ? accentColor : 'transparent'}`,
              borderBottom: `1px solid ${border}`,
              background: active ? (darkMode ? 'rgba(34,197,94,0.12)' : 'rgba(34,197,94,0.08)') : 'transparent',
              borderRadius: 0,
              padding: '9px 10px',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              boxShadow: 'none',
              transition: 'border-color 120ms ease, background-color 120ms ease',
              overflow: 'visible',
              color: title,
              textAlign: 'left',
            }}
          >
            {/* The preview uses the same lossless source as every app surface. */}
            <div
              style={{
                width: 56,
                height: 56,
                flex: '0 0 56px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: 'none',
                borderRadius: 12,
                overflow: 'hidden',
                boxShadow: 'none',
              }}
            >
              <img
                src={resolveBrandIconSrc(item.id)}
                alt={item.titleZh}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block',
                }}
                draggable={false}
              />
            </div>
            <div style={{ textAlign: 'left', minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 'var(--gn-font-size-sm, 12px)', fontWeight: 700, color: title }}>
                #{item.id} {item.titleZh}
              </div>
              <div
                style={{
                  fontSize: 'var(--gn-font-size-xs, 11px)',
                  color: muted,
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={item.titleEn}
              >
                {item.titleEn}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
