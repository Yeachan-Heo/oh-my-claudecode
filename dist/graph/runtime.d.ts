type GraphCommandOperation = 'create' | 'inspect' | 'approve' | 'ready' | 'claim' | 'complete' | 'fail' | 'propose-patch' | 'approve-patch' | 'status' | 'pause' | 'abandon' | 'resume' | 'settle-session' | 'resolve-join' | 'renew-claim' | 'recover-expired-claim' | 'record-late-claim-result' | 'release-attempt-for-retry' | 'resolve-reconciliation';
interface GraphCommandRequest {
    operation: GraphCommandOperation;
    cwd: string;
    input: Readonly<Record<string, unknown>>;
}
interface GraphCommandService {
    execute(request: GraphCommandRequest): Promise<unknown>;
}
export declare const graphCommandService: GraphCommandService;
export {};
//# sourceMappingURL=runtime.d.ts.map