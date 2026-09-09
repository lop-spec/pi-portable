package com.lop.phone;

import android.app.Application;
import android.app.Instrumentation;
import android.content.AttributionSource;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.pm.ApplicationInfo;
import java.lang.reflect.*;

/** Shell identity for framework services; no installed app, root, or user credentials. */
final class ShellContext extends ContextWrapper {
    private ShellContext(Context base) { super(base); }
    @Override public String getPackageName() { return "com.android.shell"; }
    @Override public String getOpPackageName() { return getPackageName(); }
    @Override public Context getApplicationContext() { return this; }
    @Override public AttributionSource getAttributionSource() {
        return new AttributionSource.Builder(2000).setPackageName(getPackageName()).build();
    }
    public int getDeviceId() { return 0; }
    static void set(Object instance, Class<?> owner, String name, Object value) throws Exception {
        Field f = owner.getDeclaredField(name); f.setAccessible(true); f.set(instance, value);
    }
    static ShellContext create() throws Exception {
        Class<?> type = Class.forName("android.app.ActivityThread");
        Constructor<?> ctor = type.getDeclaredConstructor(); ctor.setAccessible(true);
        Object thread = ctor.newInstance();
        set(null, type, "sCurrentActivityThread", thread);
        set(thread, type, "mSystemThread", true);
        Class<?> internal = Class.forName("android.app.ActivityThreadInternal");
        Class<?> config = Class.forName("android.app.ConfigurationController");
        Constructor<?> cc = config.getDeclaredConstructor(internal); cc.setAccessible(true);
        set(thread, type, "mConfigurationController", cc.newInstance(thread));
        Class<?> bind = Class.forName("android.app.ActivityThread$AppBindData");
        Constructor<?> bc = bind.getDeclaredConstructor(); bc.setAccessible(true);
        Object data = bc.newInstance();
        ApplicationInfo info = new ApplicationInfo(); info.packageName = "com.android.shell";
        set(data, bind, "appInfo", info); set(thread, type, "mBoundApplication", data);
        ShellContext context = new ShellContext((Context) type.getDeclaredMethod("getSystemContext").invoke(thread));
        Application app = Instrumentation.newApplication(Application.class, context);
        set(thread, type, "mInitialApplication", app);
        return context;
    }
}
