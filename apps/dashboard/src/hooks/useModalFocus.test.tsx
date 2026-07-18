import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModalFocus } from "./useModalFocus";

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  const initialRef = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); onClose(); };
  useModalFocus({ open, locked: false, containerRef, initialFocusRef: initialRef, onRequestClose: close });
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <section ref={containerRef} role="dialog" tabIndex={-1}>
          <button ref={initialRef}>Cancel</button>
          <button>Confirm</button>
        </section>
      )}
    </>
  );
}

describe("modal keyboard focus", () => {
  it("focuses the safe initial action, traps Tab, closes on Escape, and restores focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });
});
