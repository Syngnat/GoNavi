import { Alert } from 'antd';
import { DeclarativePanel } from '../plugins/DeclarativePanel';
import { usePluginInvocation } from '../plugins/usePluginInvocation';
import type { PluginCommand } from '../plugins/types';

export function DeclarativePluginPage({
  pluginID,
  generation,
  commands,
  body,
}: {
  pluginID: string;
  generation: number;
  commands: PluginCommand[];
  body: unknown;
}) {
  const invocation = usePluginInvocation(pluginID, generation, true);
  return (
    <section className="plugin-page-host" aria-label={pluginID}>
      <DeclarativePanel
        body={body}
        commands={commands}
        disabled={invocation.busy}
        invoke={(command, args) => void invocation.invoke(command, args)}
      />
      {invocation.error && <Alert type="error" showIcon message={invocation.error} />}
    </section>
  );
}
