import React from 'react';

import type { AIChatAttachment, AIChatAttachmentOcr } from '../../../types';
import { isOcrPending } from '../aiAgentAttachments';
import { isBuiltinAIProvider } from '../builtinAILogin';
import { fetchOcrServiceConfig, isOcrSupported } from './ocrComponentClient';
import { ensureOcrComponent, useOcrComponentState } from './ocrComponentStore';
import { recognizeImageText } from './ocrEngine';
import { hasMeaningfulText } from './ocrText';

/**
 * A model that cannot see images (the built-in one) is given the text in them
 * instead: when an image is attached and the provider cannot read it, the desktop
 * reads the text itself, with the installed recognition component. The person is
 * asked once whether to install it; what was read waits on the attachment until the
 * message is sent.
 */

export const providerNeedsImageText = (provider?: { id?: string; supportsImages?: boolean } | null): boolean => (
  isBuiltinAIProvider(provider) || provider?.supportsImages === false
);

const describeFailure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface UseAIImageOcrParams {
  provider?: { id?: string; supportsImages?: boolean } | null;
  draftAttachments: AIChatAttachment[];
  setDraftAttachments: React.Dispatch<React.SetStateAction<AIChatAttachment[]>>;
}

export const useAIImageOcr = ({ provider, draftAttachments, setDraftAttachments }: UseAIImageOcrParams) => {
  const wanted = isOcrSupported() && providerNeedsImageText(provider);
  const installed = useOcrComponentState().status?.installed === true;
  const attachmentsRef = React.useRef(draftAttachments);
  attachmentsRef.current = draftAttachments;
  const inFlight = React.useRef(new Set<string>());

  const record = React.useCallback((id: string, ocr: AIChatAttachmentOcr) => {
    setDraftAttachments((previous) => previous.map((item) => (item.id === id ? { ...item, ocr } : item)));
  }, [setDraftAttachments]);

  const read = React.useCallback(async (attachment: AIChatAttachment, interactive: boolean) => {
    if (!attachment.dataUrl || inFlight.current.has(attachment.id)) return;
    inFlight.current.add(attachment.id);
    try {
      record(attachment.id, { status: 'waiting' });
      if ((await ensureOcrComponent(interactive)) !== 'ready') {
        record(attachment.id, { status: 'needs_install' });
        return;
      }
      record(attachment.id, { status: 'running' });
      const service = await fetchOcrServiceConfig();
      if (!service.config) {
        record(attachment.id, { status: 'failed', error: service.message });
        return;
      }
      const { text } = await recognizeImageText(attachment.dataUrl, service.config);
      record(attachment.id, hasMeaningfulText(text) ? { status: 'done', text } : { status: 'no_text' });
    } catch (error) {
      record(attachment.id, { status: 'failed', error: describeFailure(error) });
    } finally {
      inFlight.current.delete(attachment.id);
    }
  }, [record]);

  /** For a freshly attached file: images are read when the provider cannot see them. */
  const onAttachmentAdded = React.useCallback((attachment: AIChatAttachment) => {
    if (wanted && attachment.kind === 'image') void read(attachment, false);
  }, [wanted, read]);

  /** The person asked for it: from the badge on an image that could not be read. */
  const readNow = React.useCallback((attachment: AIChatAttachment) => { void read(attachment, true); }, [read]);

  // Images attached before the provider was switched to one that cannot see them, and
  // images that were waiting for a component installed in the meantime.
  React.useEffect(() => {
    if (!wanted) return;
    attachmentsRef.current
      .filter((attachment) => attachment.kind === 'image' && attachment.dataUrl)
      .filter((attachment) => !attachment.ocr || (installed && attachment.ocr.status === 'needs_install'))
      .forEach((attachment) => { void read(attachment, false); });
  }, [wanted, installed, read]);

  return { wanted, onAttachmentAdded, readNow, recognizing: draftAttachments.some(isOcrPending) };
};
