import { BuilderCanvasPage } from '@/components/builder/canvas';

export default async function BuilderWorkflowPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await params;
  return <BuilderCanvasPage workflowId={workflowId} />;
}
