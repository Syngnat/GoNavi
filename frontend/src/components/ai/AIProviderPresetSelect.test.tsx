import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('antd', () => ({
  Select: (props: any) => (
    <div data-select="true" data-option-values={props.options.map((option: any) => option.value).join(',')} className={props.className} aria-label={props['aria-label']}>
      {typeof props.popupRender === 'function' ? props.popupRender(<div data-select-menu="true" />) : null}
    </div>
  ),
}));

import AIProviderPresetSelect from './AIProviderPresetSelect';

const partnerCopy = {
  partnerPromoLabel: '兑换码',
  partnerPromoCopyingLabel: '正在复制兑换码…',
  partnerPromoCopyFailedLabel: '自动复制失败，点击兑换码重试',
  partnerPromoCopyActionLabel: '复制',
  partnerApplyBaseUrlActionLabel: '应用 API 地址',
  partnerVisitActionLabel: '注册并领取额度',
};

describe('AIProviderPresetSelect', () => {
  it('renders a two-column popup without partner empty-state copy', () => {
    const markup = renderToStaticMarkup(
      <AIProviderPresetSelect
        value="openai"
        presets={[{ key: 'openai', label: 'OpenAI' }]}
        canSelect={() => true}
        builtinLabel="Built-in"
        partnerLabel="Sponsors"
        {...partnerCopy}
        ariaLabel="Provider"
        onChange={() => {}}
      />,
    );
    expect(markup).toContain('gonavi-ai-provider-preset-dropdown-grid');
    expect(markup).toContain('is-partner');
    expect(markup).toContain('Built-in');
    expect(markup).toContain('Sponsors');
    expect(markup).not.toContain('No sponsors yet');
  });

  it('shows the HuaLongAI benefit, copies its promo code, and waits for explicit navigation', async () => {
    const onChange = vi.fn();
    const onOpenPartner = vi.fn();
    const onCopyPartnerCode = vi.fn().mockResolvedValue(undefined);
    const props = {
      value: 'openai',
      presets: [{ key: 'openai', label: 'OpenAI' }],
      partners: [{ key: 'hualong', label: '華龍算力', logoSrc: '/sponsors/hualong-icon.png', url: 'https://api.hualong.online/register?promo=GONAVI%26HUALONG', baseUrl: 'https://api.hualong.online/v1', benefit: '1USD体验额度', promoCode: 'GONAVI&HUALONG' }],
      canSelect: () => true,
      builtinLabel: '内置支持',
      partnerLabel: '赞助商',
      ...partnerCopy,
      ariaLabel: '供应商',
      onChange,
      onOpenPartner,
      onCopyPartnerCode,
    };
    const markup = renderToStaticMarkup(<AIProviderPresetSelect {...props} />);
    expect(markup).toContain('data-option-values="openai"');
    expect(markup).toContain('gonavi-ai-provider-partner-option');
    expect(markup).toContain('/sponsors/hualong-icon.png');
    expect(markup).toContain('華龍算力');
    expect(markup).toContain('1USD体验额度');
    expect(markup).toContain('gonavi-ai-provider-partner-benefit-text');

    const renderer = create(<AIProviderPresetSelect {...props} />);
    const partner = renderer.root.findByProps({ className: 'gonavi-ai-provider-partner-option' });
    await act(async () => { await partner.props.onClick(); });
    expect(onCopyPartnerCode).toHaveBeenCalledWith('GONAVI&HUALONG');
    expect(onOpenPartner).not.toHaveBeenCalled();
    const offer = renderer.root.findByProps({ className: 'gonavi-ai-provider-partner-offer' });
    expect(offer.findByType('code').props.children).toBe('GONAVI&HUALONG');
    expect(offer.findAllByProps({ role: 'status' })).toHaveLength(0);
    const visit = offer.findByProps({ className: 'gonavi-ai-provider-partner-visit' });
    act(() => visit.props.onClick());
    expect(onOpenPartner).toHaveBeenCalledWith('https://api.hualong.online/register?promo=GONAVI%26HUALONG');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the promo code visible and offers retry when automatic copying fails', async () => {
    const renderer = create(<AIProviderPresetSelect
      value="openai"
      presets={[{ key: 'openai', label: 'OpenAI' }]}
      partners={[{ key: 'hualong', label: '華龍算力', logoSrc: '/sponsors/hualong-icon.png', url: 'https://api.hualong.online/register?promo=GONAVI%26HUALONG', baseUrl: 'https://api.hualong.online/v1', benefit: '1USD体验额度', promoCode: 'GONAVI&HUALONG' }]}
      canSelect={() => true}
      builtinLabel="内置支持"
      partnerLabel="赞助商"
      {...partnerCopy}
      ariaLabel="供应商"
      onChange={() => {}}
      onCopyPartnerCode={vi.fn().mockRejectedValue(new Error('clipboard denied'))}
    />);
    await act(async () => { await renderer.root.findByProps({ className: 'gonavi-ai-provider-partner-option' }).props.onClick(); });
    expect(renderer.root.findByType('code').props.children).toBe('GONAVI&HUALONG');
    expect(renderer.root.findByProps({ role: 'status' }).props.children).toContain('自动复制失败');
  });

  it('applies the HuaLongAI API address without opening the registration page', async () => {
    const onApplyPartnerBaseUrl = vi.fn();
    const onOpenPartner = vi.fn();
    const renderer = create(<AIProviderPresetSelect
      value="openai"
      presets={[{ key: 'openai', label: 'OpenAI' }]}
      partners={[{ key: 'hualong', label: '華龍算力', logoSrc: '/sponsors/hualong-icon.png', url: 'https://api.hualong.online/register?promo=GONAVI%26HUALONG', baseUrl: 'https://api.hualong.online/v1', benefit: '1USD体验额度', promoCode: 'GONAVI&HUALONG' }]}
      canSelect={() => true}
      builtinLabel="内置支持"
      partnerLabel="赞助商"
      {...partnerCopy}
      ariaLabel="供应商"
      onChange={() => {}}
      onCopyPartnerCode={vi.fn().mockResolvedValue(undefined)}
      onApplyPartnerBaseUrl={onApplyPartnerBaseUrl}
      onOpenPartner={onOpenPartner}
    />);
    await act(async () => { await renderer.root.findByProps({ className: 'gonavi-ai-provider-partner-option' }).props.onClick(); });
    act(() => renderer.root.findByProps({ className: 'gonavi-ai-provider-partner-apply' }).props.onClick());
    expect(onApplyPartnerBaseUrl).toHaveBeenCalledWith('https://api.hualong.online/v1', '華龍算力');
    expect(onOpenPartner).not.toHaveBeenCalled();
  });
});
