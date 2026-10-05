import React from 'react';
import { Button, Modal } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';

import { t as catalogTranslate } from '../../../i18n/catalog';
import { useOptionalI18n } from '../../../i18n/provider';
import {
  acceptBuiltinAITerms,
  declineBuiltinAITerms,
  useBuiltinAITermsPromptOpen,
} from './builtinAITermsStore';
import './builtinTerms.css';

/** The sections of the rules, in the order they are shown, and how many points each has. */
export const BUILTIN_AI_TERMS_SECTIONS = [
  { key: 'scope', points: 2 },
  { key: 'forbidden', points: 5 },
  { key: 'data', points: 4 },
  { key: 'notes', points: 3 },
] as const;

// The prompt can be mounted from the settings page and from the chat panel at once;
// only the first mounted one draws it, so there is never a second copy on top.
const mounted: symbol[] = [];
const mountListeners = new Set<() => void>();
const notifyMounted = () => mountListeners.forEach((listener) => listener());
const subscribeMounted = (listener: () => void) => {
  mountListeners.add(listener);
  return () => { mountListeners.delete(listener); };
};
const getFirstMounted = (): symbol | undefined => mounted[0];

const useIsPromptOwner = (): boolean => {
  const [id] = React.useState(() => Symbol('builtin-ai-terms'));
  const first = React.useSyncExternalStore(subscribeMounted, getFirstMounted, getFirstMounted);
  React.useEffect(() => {
    mounted.push(id);
    notifyMounted();
    return () => {
      mounted.splice(mounted.indexOf(id), 1);
      notifyMounted();
    };
  }, [id]);
  return first === id;
};

/**
 * Before the first sign-in to the built-in AI the person is shown, in their language, what
 * it may be used for, what it may not, and what is and is not done with their data. Signing
 * in goes on only when they accept.
 */
export const BuiltinAITermsModal: React.FC = () => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const open = useBuiltinAITermsPromptOpen();
  const owner = useIsPromptOwner();
  // Nothing is drawn (and no modal machinery runs) until the first time it is asked for; after
  // that it stays, so closing can fade out.
  const [everOpened, setEverOpened] = React.useState(false);
  React.useEffect(() => { if (open) setEverOpened(true); }, [open]);
  if (!owner || !(open || everOpened)) return null;

  return (
    <Modal
      open={open}
      centered
      width={560}
      maskClosable={false}
      keyboard
      onCancel={declineBuiltinAITerms}
      title={(
        <div className="gn-ai-terms-title">
          <SafetyCertificateOutlined />
          <span>{t('ai_builtin_terms.title')}</span>
        </div>
      )}
      footer={(
        <>
          <Button onClick={declineBuiltinAITerms}>{t('ai_builtin_terms.decline')}</Button>
          <Button type="primary" onClick={() => acceptBuiltinAITerms()}>{t('ai_builtin_terms.accept')}</Button>
        </>
      )}
    >
      <div className="gn-ai-terms-body">
        <p className="gn-ai-terms-intro">{t('ai_builtin_terms.intro')}</p>
        {BUILTIN_AI_TERMS_SECTIONS.map((section) => (
          <section key={section.key} className="gn-ai-terms-section" data-section={section.key}>
            <h4>{t(`ai_builtin_terms.${section.key}.title`)}</h4>
            <ul>
              {Array.from({ length: section.points }, (_, index) => (
                <li key={index}>{t(`ai_builtin_terms.${section.key}.item${index + 1}`)}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
};

export default BuiltinAITermsModal;
