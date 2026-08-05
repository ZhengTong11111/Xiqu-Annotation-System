export type BootstrapAdminCliOptions = {
  accountName: string;
  displayName: string;
};

/**
 * CLI 只接受非敏感身份参数；密码固定从 stdin 读取，避免出现在 shell history 和进程列表。
 */
export function parseBootstrapAdminArguments(argumentsList: string[]): BootstrapAdminCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if ((option !== "--account-name" && option !== "--display-name") || value === undefined) {
      throw new Error(
        "用法：admin:bootstrap -- --account-name <账号> --display-name <显示名>，密码由 stdin 提供。",
      );
    }
    if (values.has(option)) throw new Error(`参数重复：${option}`);
    values.set(option, value);
  }
  const accountName = values.get("--account-name");
  const displayName = values.get("--display-name");
  if (!accountName || !displayName || values.size !== 2) {
    throw new Error("必须同时提供 --account-name 和 --display-name。");
  }
  return { accountName, displayName };
}

// stdin 设置硬上限，避免误把文件或无限流当成密码读入进程内存。
export async function readBootstrapPasswordFromStdin(
  input: AsyncIterable<unknown>,
) {
  let password = "";
  for await (const chunk of input) {
    password += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(password, "utf8") > 1024) {
      throw new Error("stdin 中的管理员密码过长。");
    }
  }
  return password.replace(/\r?\n$/, "");
}
