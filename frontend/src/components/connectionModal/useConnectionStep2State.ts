import { useKafkaSecuritySync } from "./ConnectionModalKafkaAuth";
import React from "react";
import { URI_FEEDBACK_AUTO_DISMISS_MS } from "./connectionStep2Constants";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

export interface UseConnectionStep2StateInput {
  form: ConnectionModalStep2Props['form'];
  isKafka: ConnectionModalStep2Props['isKafka'];
  setUseSSL: ConnectionModalStep2Props['setUseSSL'];
  dbType: ConnectionModalStep2Props['dbType'];
  initialValues: ConnectionModalStep2Props['initialValues'];
  isPulsar: ConnectionModalStep2Props['isPulsar'];
  setUseSSH: ConnectionModalStep2Props['setUseSSH'];
  setUseProxy: ConnectionModalStep2Props['setUseProxy'];
  setUseHttpTunnel: ConnectionModalStep2Props['setUseHttpTunnel'];
  uriFeedback: ConnectionModalStep2Props['uriFeedback'];
  setUriFeedback: ConnectionModalStep2Props['setUriFeedback'];
}

export const useConnectionStep2State = ({
  form,
  isKafka,
  setUseSSL,
  dbType,
  initialValues,
  isPulsar,
  setUseSSH,
  setUseProxy,
  setUseHttpTunnel,
  uriFeedback,
  setUriFeedback,
}: UseConnectionStep2StateInput) => {
  useKafkaSecuritySync(form, isKafka, setUseSSL);
  const pulsarPortEditedRef = React.useRef(false);

  React.useEffect(() => {
    pulsarPortEditedRef.current = false;
  }, [dbType, initialValues?.id]);

  React.useEffect(() => {
    if (!isPulsar) return;
    form.setFieldsValue({ useSSH: false, useProxy: false, useHttpTunnel: false });
    setUseSSH(false);
    setUseProxy(false);
    setUseHttpTunnel(false);
  }, [form, isPulsar, setUseHttpTunnel, setUseProxy, setUseSSH]);

  // 默认折叠生产保护，避免默认表单内容溢出触发滚动条；保留用户按需展开的交互。
  const [readOnlyProtectionExpanded, setReadOnlyProtectionExpanded] =
    React.useState(false);

  React.useEffect(() => {
    setReadOnlyProtectionExpanded(false);
  }, [dbType]);

  React.useEffect(() => {
    if (!uriFeedback) return undefined;
    const dismissTimer = window.setTimeout(() => {
      setUriFeedback(null);
    }, URI_FEEDBACK_AUTO_DISMISS_MS);
    return () => window.clearTimeout(dismissTimer);
  }, [setUriFeedback, uriFeedback]);
  return {
    pulsarPortEditedRef,
    readOnlyProtectionExpanded,
    setReadOnlyProtectionExpanded,
  };
};

export type ConnectionStep2StateApi = ReturnType<typeof useConnectionStep2State>;
