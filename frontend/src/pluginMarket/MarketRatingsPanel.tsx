import { useState } from 'react';
import { Button, Pagination, Rate, Typography } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import { BrowserOpenURL } from '../../wailsjs/runtime';
import { useI18n } from '../i18n/provider';
import type { MarketRating } from './types';

export function MarketRatingsPanel({ ratings, websiteURL }: { ratings: MarketRating[]; websiteURL: string }) {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(ratings.length / 10)));
  return <section className="market-detail-ratings" aria-label={t('plugin.market.ratings')}>
    <Typography.Title level={5}>{t('plugin.market.ratings')}</Typography.Title>
    {ratings.length === 0 && <div className="market-detail-rating-empty"><Typography.Text type="secondary">{t('plugin.market.detail_reviews_empty')}</Typography.Text></div>}
    {ratings.slice((currentPage - 1) * 10, currentPage * 10).map((rating) => <article className="market-detail-rating" key={rating.userId}>
      <div className="market-detail-rating-header"><Typography.Text strong>{rating.userId}</Typography.Text><Rate disabled value={rating.stars} /></div>
      <Typography.Text type="secondary" className="market-detail-rating-meta">{rating.version} · {rating.updatedAt}</Typography.Text>
      <p className="plugin-rating-body">{rating.body}</p>
    </article>)}
    {ratings.length > 10 && <Pagination current={currentPage} onChange={setPage} total={ratings.length} pageSize={10} showSizeChanger={false} />}
    <div className="market-detail-rating-gate market-detail-rating-website"><Typography.Text type="secondary">{t('plugin.market.ratings_on_website')}</Typography.Text>
      {websiteURL && <Button type="link" href={websiteURL} target="_blank" rel="noopener noreferrer" icon={<ExportOutlined aria-hidden />} onClick={(event) => {
        event.preventDefault();
        try { BrowserOpenURL(websiteURL); } catch { window.open(websiteURL, '_blank', 'noopener,noreferrer'); }
      }}>{t('plugin.market.open_website')}</Button>}
    </div>
  </section>;
}
