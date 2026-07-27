import { Icon } from "../../icons.js";

interface ComposerSubmitControlProps {
  mode: "stop" | "send";
  disabled: boolean;
  steer?: boolean;
  onStop(): void;
}

export function ComposerSubmitControl({
  mode,
  disabled,
  steer = false,
  onStop,
}: ComposerSubmitControlProps) {
  if (mode === "stop") {
    return (
      <button
        className="v11-send-button v11-composer-stop"
        type="button"
        aria-label="停止"
        disabled={disabled}
        onClick={onStop}
      >
        <span className="v11-stop-square" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      className="v11-send-button"
      type="submit"
      aria-label={steer ? "发送 Steer" : "发送消息"}
      disabled={disabled}
    >
      <Icon name="send" />
    </button>
  );
}
