import type { ReactNode } from 'react';

interface AIPluginProviderSectionProps {
  title: string;
  hint?: string;
  children: ReactNode;
}

// One ruled block: a title, a quiet hint, then content. Sections replace the nested
// cards and grey fills that made the provider form read like a management console.
export function AIPluginProviderSection({ title, hint, children }: AIPluginProviderSectionProps) {
  return (
    <section className="gn-section">
      <header className="gn-section-head">
        <h3 className="gn-section-title">{title}</h3>
        {hint && <p className="gn-section-hint">{hint}</p>}
      </header>
      <div className="gn-section-body">{children}</div>
    </section>
  );
}
