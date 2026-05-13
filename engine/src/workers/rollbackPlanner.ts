import { supabase } from "../lib/supabase.js";

export interface RollbackPlan {
  diff_id: string;
  file_path: string;
  base_commit: string;
  strategy: "GIT_REVERT" | "RESTORE_CHUNKS";
  instructions: string;
  can_auto_rollback: boolean;
}

export async function generateRollbackPlan(
  projectId: string,
  diffId: string,
  filePath: string
): Promise<RollbackPlan> {
  const { data: commits } = await supabase
    .from("commit_index")
    .select("commit_hash, message, timestamp")
    .eq("project_id", projectId)
    .order("timestamp", { ascending: false })
    .limit(5);

  const baseCommit = commits?.[1]?.commit_hash || commits?.[0]?.commit_hash || "HEAD~1";

  const { data: fileCommit } = await supabase
    .from("commit_file_changes")
    .select("commit_hash, committed_at")
    .eq("project_id", projectId)
    .eq("file_path", filePath)
    .order("committed_at", { ascending: false })
    .limit(2);

  const previousCommit = fileCommit?.[1]?.commit_hash || baseCommit;

  return {
    diff_id: diffId,
    file_path: filePath,
    base_commit: previousCommit,
    strategy: "GIT_REVERT",
    instructions: `git checkout ${previousCommit} -- ${filePath}`,
    can_auto_rollback: !!previousCommit,
  };
}
