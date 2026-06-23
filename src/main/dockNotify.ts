import { Notification, shell } from 'electron';
import path from 'node:path';

/** R-DOCK-FLOATING #notify — dock 录屏完成 / 失败时的系统级反馈。
 *
 *  done 阶段 dock 内 toast 8 秒自动消失，用户可能完全错过；
 *  这里挂一个 Electron Notification（macOS 走原生通知中心，
 *  Win/Linux 走系统通知），点击 = 在 Finder/Explorer 高亮 gif，
 *  让用户在不打开主窗的情况下也能找到产物。
 *
 *  Notification.isSupported() 在某些 CI / headless Linux 下是 false，
 *  此时直接 no-op，保留原有 dock toast 链路即可。 */
export function notifyDockRecordingFinished(args: {
  gifPath: string;
  log: (msg: string) => void;
}): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: '录屏完成',
      body: `${path.basename(args.gifPath)} · 点击在文件管理器中查看`,
      silent: false,
    });
    n.on('click', () => {
      try { shell.showItemInFolder(args.gifPath); } catch (e) { args.log(`dock notify click failed: ${(e as Error).message}`); }
    });
    n.show();
  } catch (e) {
    args.log(`dock notify show failed: ${(e as Error).message}`);
  }
}

export function notifyDockRecordingFailed(args: {
  message: string;
  log: (msg: string) => void;
}): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: '录屏失败',
      body: args.message.slice(0, 200),
      silent: false,
    });
    n.show();
  } catch (e) {
    args.log(`dock notify error failed: ${(e as Error).message}`);
  }
}
