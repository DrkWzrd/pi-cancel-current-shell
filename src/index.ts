import {
  createBashTool,
  createPowerShellTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type ToolLike = {
  execute: (...args: any[]) => Promise<any>;
  [key: string]: any;
};

type ActiveExecution = {
  toolName: "bash" | "powershell";
  controller: AbortController;
  startedAt: number;
  /** Optional user-supplied reason attached by /cancel-current-shell, included in the cancellation result. */
  reason?: string;
};

/**
 * Combines several abort signals into one, with a dispose() that removes any
 * listeners the fallback implementation attached.
 */
function combineSignals(signals: AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(signals), dispose: () => {} };
  }

  const controller = new AbortController();
  const listeners: Array<[AbortSignal, () => void]> = [];

  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    listeners.push([signal, abort]);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

/** Pulls the concatenated text content out of a tool result / partial update. */
function extractText(result: any): string {
  if (!result?.content || !Array.isArray(result.content)) return "";
  return result.content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("");
}

/** Builds the message the model sees when the user cancels a shell command. */
function cancellationMessage(
  toolName: string,
  partialOutput: string,
  userReason?: string,
): string {
  const header = `The user cancelled the ${toolName} script execution.`;
  const output = partialOutput.trim();
  const user = userReason?.trim();

  let text = output
    ? `${output}\n\n ${header}`
    : `${header} No output was produced before cancellation. Continue.`;

  if (user) {
    text += `\n\nThe user has given this reason: ${user}`;
  }

  return text;
}

function cancellationResult(
  toolName: string,
  partialOutput: string,
  userReason?: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: cancellationMessage(toolName, partialOutput, userReason),
      },
    ],
    details: {},
  };
}

/** Errors the base tool may throw on abort that carry no useful output. */
function isGenericAbortMessage(message: string): boolean {
  return /^(aborted|command aborted|the operation was aborted\.?)$/i.test(
    message.trim(),
  );
}

export default function (pi: ExtensionAPI) {
  const active = new Map<string, ActiveExecution>();

  // Keep Pi responsible for shell resolution, streaming, truncation, and
  // platform-specific process-tree termination.
  const bash = createBashTool(pi.cwd);
  const powershell = createPowerShellTool(pi.cwd);

  function wrapTool<T extends ToolLike>(
    toolName: "bash" | "powershell",
    baseTool: T,
  ): T {
    const wrapped = {
      ...baseTool,
      async execute(...args: any[]) {
        const [toolCallId, _params, piSignal, onUpdate] = args as [
          string,
          unknown,
          AbortSignal,
          ((partial: any) => void) | undefined,
          unknown,
        ];

        const controller = new AbortController();
        const { signal, dispose } = combineSignals([
          piSignal,
          controller.signal,
        ]);

        active.set(toolCallId, {
          toolName,
          controller,
          startedAt: Date.now(),
        });

        // Remember the latest streamed output while still forwarding every
        // update to Pi so the UI keeps streaming normally.
        // Assumes each update holds the current (possibly tail-truncated)
        // output. If you only ever see the last chunk, switch to `+=`.
        let lastPartial = "";

        // Preserve every argument; replace only the signal and onUpdate.
        const forwarded = [...args];
        forwarded[2] = signal;
        forwarded[3] = (partial: any) => {
          const text = extractText(partial);
          if (text) lastPartial = text;
          if (typeof onUpdate === "function") onUpdate(partial);
        };

        const cancelledByUs = () =>
          controller.signal.aborted && !piSignal.aborted;

        try {
          const result = await baseTool.execute(...forwarded);

          // If the base tool resolves (rather than rejects) on abort, still
          // surface the cancellation message along with whatever it returned.
          if (cancelledByUs()) {
            return cancellationResult(
              toolName,
              extractText(result) || lastPartial,
              active.get(toolCallId)?.reason,
            );
          }

          return result;
        } catch (error: any) {
          // Never propagate our own AbortError to Pi's agent loop.
          if (cancelledByUs()) {
            // Prefer streamed output. Some versions of Pi's shell tools embed
            // the captured output in the abort error, so fall back to that
            // unless it's just a generic "aborted" message.
            const fallback =
              error instanceof Error && !isGenericAbortMessage(error.message)
                ? error.message
                : "";
            return cancellationResult(
              toolName,
              lastPartial || fallback,
              active.get(toolCallId)?.reason,
            );
          }
          throw error;
        } finally {
          dispose();
          active.delete(toolCallId);
        }
      },
    };

    return wrapped as T;
  }

  // defaultActive: false so these re-registered wrappers do not force-activate
  // on registration, keeping `-bash`/`-powershell` in defaultTools effective.
  pi.registerTool({ ...wrapTool("bash", bash), defaultActive: false });
  pi.registerTool({
    ...wrapTool("powershell", powershell),
    defaultActive: false,
  });

  pi.registerCommand("cancel-current-shell", {
    description:
      "Interrupt the most recently started bash or PowerShell command without cancelling the agent turn. Optional argument: a reason included in the cancellation result the agent sees.",
    handler: async (args, ctx) => {
      const current = [...active.entries()].sort(
        (a, b) => b[1].startedAt - a[1].startedAt,
      )[0];

      if (!current) {
        ctx.ui.notify("No active shell execution to cancel.", "info");
        return;
      }

      const [toolCallId, execution] = current;

      const reason = args.trim();
      if (reason) execution.reason = reason;

      execution.controller.abort();

      ctx.ui.notify(
        `Cancellation requested for ${execution.toolName} execution (${toolCallId}).`,
        "warning",
      );
    },
  });
}