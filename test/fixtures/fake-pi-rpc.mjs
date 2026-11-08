let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
	let newline;
	while ((newline = input.indexOf("\n")) !== -1) {
		const line = input.slice(0, newline);
		input = input.slice(newline + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
});
process.stdin.on("end", () => process.exit(0));

function send(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(command, id, data) {
	send({ id, type: "response", command, success: true, data });
}

function handle(command) {
	const { id, type } = command;
	if (type === "get_state") {
		respond(type, id, { isStreaming: false, messageCount: 0 });
		return;
	}
	if (type === "get_messages") {
		respond(type, id, { messages: [{ role: "assistant", content: [{ type: "text", text: "fake" }] }] });
		return;
	}
	if (type !== "prompt") {
		send({ id, type: "response", command: type, success: false, error: `Unknown fake command ${type}` });
		return;
	}
	if (command.message === "/failure") {
		send({ id, type: "response", command: type, success: false, error: "injected prompt failure" });
		return;
	}
	if (command.message === "/handled-noop") {
		respond(type, id, { disposition: "handled" });
		return;
	}
	if (command.message === "/extension-error") {
		respond(type, id, { disposition: "handled" });
		send({ type: "extension_error", extensionPath: "<runtime>", event: "send_user_message", error: "No API key found" });
		return;
	}
	if (command.message === "/handled-event-first") {
		send({ type: "agent_start" });
		respond(type, id, { disposition: "handled" });
		send({ type: "agent_settled", aborted: false });
		return;
	}
	if (command.message === "/notify-run") {
		send({ type: "extension_ui_request", id: "notice", method: "notify", message: "fake notice", notifyType: "info" });
		respond(type, id, { disposition: "started" });
		send({ type: "agent_start" });
		send({ type: "agent_settled", aborted: false });
		return;
	}
	respond(type, id, { disposition: "started" });
	send({ type: "agent_start" });
	send({ type: "agent_settled", aborted: false });
}
