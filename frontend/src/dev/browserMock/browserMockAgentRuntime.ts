import { cloneBrowserMockValue } from '../../utils/browserMockConnections';

export interface CreateBrowserMockAgentRuntimeInput {
    mockAgentRuns: Map<string, any>;
    emitLocalRuntimeEvent: (eventName: string, ...args: any[]) => void;
    mockAgentSessions: Map<string, any>;
    mockAgentSessionSequenceRef: { current: number; };
    mockAgentSequenceRef: { current: number; };
}

export const createBrowserMockAgentRuntime = ({
    mockAgentRuns, emitLocalRuntimeEvent, mockAgentSessions, mockAgentSessionSequenceRef,
    mockAgentSequenceRef,
}: CreateBrowserMockAgentRuntimeInput) => {
    const mockAgentNow = () => new Date().toISOString();
    const cloneMockAgentSession = (session: any, includeMessages = true) => ({
        sessionId: session.id,
        title: session.title,
        revision: session.revision,
        generation: session.generation,
        archived: session.archived === true,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        runs: [...mockAgentRuns.values()]
            .filter((run) => run.sessionId === session.id)
            .map((run) => cloneBrowserMockValue(run.snapshot)),
        ...(includeMessages ? { messages: cloneBrowserMockValue(session.messages) } : {}),
    });
    const emitMockAgentEvent = (
        run: any,
        kind: string,
        payload: Record<string, unknown>,
        resultingState = run.snapshot.state,
    ) => {
        const sequence = run.snapshot.nextSequence;
        const event = {
            schemaVersion: 1,
            runId: run.snapshot.runId,
            sessionId: run.snapshot.sessionId,
            sessionGeneration: run.snapshot.sessionGeneration,
            sequence,
            runRevision: run.snapshot.revision,
            attempt: run.snapshot.attempt,
            timestamp: mockAgentNow(),
            kind,
            resultingState,
            payload,
        };
        run.nextSequence = sequence;
        run.snapshot.nextSequence = sequence + 1;
        run.events.push(event);
        emitLocalRuntimeEvent('ai:run:event', cloneBrowserMockValue(event));
        return event;
    };
    const updateMockAgentRunState = (run: any, state: string) => {
        run.snapshot.state = state;
        run.snapshot.revision += 1;
        run.snapshot.updatedAt = mockAgentNow();
        const session = mockAgentSessions.get(run.snapshot.sessionId);
        if (session) {
            session.revision += 1;
            session.updatedAt = run.snapshot.updatedAt;
        }
    };
    const mockAgentResponse = (request: any) => request?.taskKind === 'query_editor_generation'
        ? 'SELECT * FROM `videos` LIMIT 100;'
        : 'Browser mock agent response.';
    const runMockAgentTurn = (run: any, request: any) => {
        window.setTimeout(() => {
            if (run.snapshot.state === 'canceled') return;
            updateMockAgentRunState(run, 'running_model');
            const text = mockAgentResponse(request);
            emitMockAgentEvent(run, 'model_delta', { text }, 'running_model');
            window.setTimeout(() => {
                if (run.snapshot.state === 'canceled') return;
                emitMockAgentEvent(run, 'model_completed', { text }, 'running_model');
                const session = mockAgentSessions.get(run.snapshot.sessionId);
                if (session) {
                    session.messages.push({
                        id: `agent-message-${run.snapshot.runId}-assistant`,
                        sessionId: run.snapshot.sessionId,
                        runId: run.snapshot.runId,
                        sequence: run.nextSequence,
                        role: 'assistant',
                        content: text,
                        createdAt: mockAgentNow(),
                    });
                }
                updateMockAgentRunState(run, 'completed');
                emitMockAgentEvent(run, 'terminal', { reason: 'completed' }, 'completed');
            }, 0);
        }, 0);
    };
    const submitMockAgentInput = async (request: any) => {
        const requestId = String(request?.requestId || '').trim();
        if (!requestId) throw new Error('requestId is required');
        const requestedSessionId = String(request?.sessionId || '').trim();
        const sessionId = requestedSessionId || `agent-session-${++mockAgentSessionSequenceRef.current}`;
        let session = mockAgentSessions.get(sessionId);
        if (!session) {
            const now = mockAgentNow();
            session = {
                id: sessionId,
                title: String(request?.content || 'New conversation').trim().slice(0, 80) || 'New conversation',
                revision: 1,
                generation: 1,
                archived: false,
                createdAt: now,
                updatedAt: now,
                messages: [],
            };
            mockAgentSessions.set(sessionId, session);
        }
        if (Number(request?.expectedRevision || 0) > 0 && Number(request.expectedRevision) !== session.revision) {
            throw new Error('revision_conflict');
        }
        const content = String(request?.content || '');
        const activeRun = [...mockAgentRuns.values()]
            .reverse()
            .find((candidate) => candidate.snapshot.sessionId === sessionId
                && !['completed', 'failed', 'canceled', 'exhausted'].includes(candidate.snapshot.state));
        if (request?.dispatchMode === 'steer' && activeRun) {
            session.messages.push({
                id: `agent-message-${activeRun.snapshot.runId}-steer-${Date.now()}`,
                sessionId,
                runId: activeRun.snapshot.runId,
                sequence: activeRun.nextSequence + 1,
                role: 'user',
                content,
                createdAt: mockAgentNow(),
            });
            session.revision += 1;
            session.updatedAt = mockAgentNow();
            activeRun.snapshot.revision += 1;
            emitMockAgentEvent(activeRun, 'input', { requestId, dispatchMode: 'steer' });
            return {
                requestId,
                sessionId,
                runId: activeRun.snapshot.runId,
                disposition: 'steered',
                revision: activeRun.snapshot.revision,
                state: activeRun.snapshot.state,
            };
        }
        const runId = `agent-run-${++mockAgentSequenceRef.current}`;
        const now = mockAgentNow();
        const run = {
            nextSequence: 0,
            events: [] as any[],
            snapshot: {
                runId,
                sessionId,
                requestId,
                sessionGeneration: session.generation,
                state: 'queued',
                revision: 1,
                attempt: 1,
                nextSequence: 1,
                createdAt: now,
                updatedAt: now,
                taskKind: request?.taskKind || 'chat',
                allowTools: request?.allowTools !== false,
                provider: String(request?.provider || ''),
                model: String(request?.model || ''),
                thinking: String(request?.thinking || ''),
            },
        };
        mockAgentRuns.set(runId, run);
        session.messages.push({
            id: `agent-message-${runId}-user`,
            sessionId,
            runId,
            sequence: 0,
            role: 'user',
            content,
            attachments: Array.isArray(request?.attachments) ? cloneBrowserMockValue(request.attachments) : [],
            createdAt: now,
        });
        session.revision += 1;
        session.updatedAt = now;
        emitMockAgentEvent(run, 'input', { requestId, dispatchMode: request?.dispatchMode || 'queue' }, 'queued');
        runMockAgentTurn(run, request);
        return {
            requestId,
            sessionId,
            runId,
            disposition: 'started',
            revision: run.snapshot.revision,
            state: run.snapshot.state,
        };
    };
    const controlMockAgentRun = async (request: any) => {
        const run = mockAgentRuns.get(String(request?.runId || '').trim());
        if (!run) throw new Error('run not found');
        if (Number(request?.expectedRevision || 0) > 0 && Number(request.expectedRevision) !== run.snapshot.revision) {
            throw new Error('revision_conflict');
        }
        if (request?.action === 'cancel' && !['completed', 'failed', 'canceled', 'exhausted'].includes(run.snapshot.state)) {
            updateMockAgentRunState(run, 'canceled');
            emitMockAgentEvent(run, 'terminal', { reason: 'canceled' }, 'canceled');
        }
        return cloneBrowserMockValue(run.snapshot);
    };
    return {
        mockAgentNow, cloneMockAgentSession, submitMockAgentInput, controlMockAgentRun,
    };
};
