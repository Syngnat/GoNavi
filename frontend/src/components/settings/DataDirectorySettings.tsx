import React from 'react';
import { InfoCircleOutlined } from '@ant-design/icons';

import './DataDirectorySettings.css';

type DataDirectoryPageProps = React.PropsWithChildren<{
  testId?: string;
}>;

export const DataDirectoryPage: React.FC<DataDirectoryPageProps> = ({ children, testId }) => (
  <div className="gn-storage-page" data-data-directory-page={testId}>
    {children}
  </div>
);

type DirectorySectionHeadingProps = {
  description?: React.ReactNode;
  title: React.ReactNode;
};

export const DirectorySectionHeading: React.FC<DirectorySectionHeadingProps> = ({
  description,
  title,
}) => (
  <div className="gn-storage-section-heading">
    <div>
      <h3 className="gn-storage-section__title">{title}</h3>
      {description ? <p className="gn-storage-section__description">{description}</p> : null}
    </div>
  </div>
);

type DirectoryPathDisplayProps = {
  action?: React.ReactNode;
  label: React.ReactNode;
  path?: string;
};

export const DirectoryPathDisplay: React.FC<DirectoryPathDisplayProps> = ({
  action,
  label,
  path,
}) => (
  <div className="gn-storage-path">
    <div className="gn-storage-path__copy">
      <span className="gn-storage-path__label">{label}</span>
      <span className="gn-storage-path__value">{path || '-'}</span>
    </div>
    {action}
  </div>
);

export type DirectoryMetaItem = {
  label: React.ReactNode;
  value?: React.ReactNode;
};

export const DirectoryMetaGrid: React.FC<{ items: DirectoryMetaItem[] }> = ({ items }) => (
  <div className="gn-storage-meta-grid">
    {items.map((item, index) => (
      <div className="gn-storage-meta" key={`${String(item.label)}-${index}`}>
        <span className="gn-storage-meta__label">{item.label}</span>
        <span className="gn-storage-meta__value">{item.value || '-'}</span>
      </div>
    ))}
  </div>
);

export const DirectoryNote: React.FC<React.PropsWithChildren> = ({ children }) => (
  <div className="gn-storage-note">
    <InfoCircleOutlined aria-hidden="true" />
    <span>{children}</span>
  </div>
);

type DirectoryChoiceProps = React.PropsWithChildren<{
  action: React.ReactNode;
  badge?: React.ReactNode;
  description: React.ReactNode;
  recommended?: boolean;
  title: React.ReactNode;
}>;

export const DirectoryChoice: React.FC<DirectoryChoiceProps> = ({
  action,
  badge,
  description,
  recommended = false,
  title,
}) => (
  <div className={`gn-storage-choice${recommended ? ' gn-storage-choice--recommended' : ''}`}>
    <div>
      <div className="gn-storage-choice__title">
        {title}
        {badge ? <span className="gn-storage-choice__badge">{badge}</span> : null}
      </div>
      <div className="gn-storage-choice__description">{description}</div>
    </div>
    {action}
  </div>
);
