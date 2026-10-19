package com.tmh.whosteammate;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * TmhClipboard —— 原生剪贴板插件。
 *
 * 为什么需要它：
 *   WebView 里 navigator.clipboard 需要安全上下文 + 页面焦点，
 *   document.execCommand('copy') 在新版 WebView / 部分 ROM 上也会被静默拒绝，
 *   结果就是"提示已复制，但粘贴不出来"。
 *   这里直接调用系统 ClipboardManager，复制必定成功。
 *
 * 调用：Capacitor.Plugins.TmhClipboard.copy({ text: '...' })
 */
@CapacitorPlugin(name = "TmhClipboard")
public class ClipboardPlugin extends Plugin {

    @PluginMethod
    public void copy(final PluginCall call) {
        final String text = call.getString("text", "");
        try {
            final Context ctx = getContext();
            // Android 10+ 必须在主线程操作剪贴板（部分 ROM 会检查）
            new Handler(Looper.getMainLooper()).post(new Runnable() {
                @Override
                public void run() {
                    try {
                        ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cm == null) {
                            call.reject("系统剪贴板不可用");
                            return;
                        }
                        ClipData clip = ClipData.newPlainText("TMH", text);
                        cm.setPrimaryClip(clip);

                        // Android 13 起系统会自带一个复制成功的浮层，不再重复提示
                        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                            Toast.makeText(ctx, "已复制", Toast.LENGTH_SHORT).show();
                        }
                        JSObject ret = new JSObject();
                        ret.put("ok", true);
                        call.resolve(ret);
                    } catch (Exception e) {
                        call.reject("复制失败：" + e.getMessage());
                    }
                }
            });
        } catch (Exception e) {
            call.reject("复制失败：" + e.getMessage());
        }
    }
}
