package com.opennote.app;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * Stand-in for the app's plugin of the same name, to call the JNI entry point from a JVM on the PC
 * (run.sh): `info`, and `geometry` on a three-point stroke. Exits 1 when a reply is wrong.
 */
public class OpenNoteRustPlugin {
    private static native byte[] nativeCall(String method, byte[] request);
    static native long liveNew(double[] params);
    static native boolean liveAdd(long h, double x, double y, double force, double t);
    static native double[] liveUpdate(long h);
    static native void liveFree(long h);

    static byte[] frame(String meta, double[] data) {
        byte[] m = meta.getBytes(StandardCharsets.UTF_8);
        ByteBuffer b = ByteBuffer.allocate(4 + m.length + data.length * 8).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(m.length).put(m);
        for (double d : data) b.putDouble(d);
        return b.array();
    }

    static String meta(byte[] reply) {
        int n = ByteBuffer.wrap(reply).order(ByteOrder.LITTLE_ENDIAN).getInt();
        return new String(reply, 4, n, StandardCharsets.UTF_8);
    }

    public static void main(String[] args) {
        System.load(args[0]);
        String info = meta(nativeCall("info", frame("{}", new double[0])));
        System.out.println("info: " + info);
        double[] pts = { 10, 10, 0.5, 0, 20, 12, 0.5, 8, 30, 15, 0.5, 16, 40, 19, 0.5, 24 };
        byte[] reply = nativeCall("geometry", frame("{\"strokes\":[{\"tool\":\"pen\",\"penStyle\":\"fountain\",\"width\":2,\"n\":4}]}", pts));
        String geo = meta(reply);
        System.out.println("geometry: " + geo + " (" + reply.length + " bytes)");
        String bad = meta(nativeCall("nope", frame("{}", new double[0])));
        System.out.println("unknown method: " + bad);
        // Native live ink: a 40-sample stroke (identity placement, k = 2), the line in view units.
        long h = liveNew(new double[] { 0, 0, 1, 1, 1, 1, 0, 1000, 0, 0, 2, 2.8, 1 });
        boolean added = h != 0;
        for (int i = 0; i < 40; i++) added &= liveAdd(h, 100 + i * 2.5, 200 + 10 * Math.sin(i / 5.0), 0.3 + 0.01 * i, 1 + i * 0.004);
        double[] line = liveUpdate(h);
        liveFree(h);
        boolean liveOk = added && line != null && line.length > 30 && (line.length - 1) % 3 == 0 && line[0] >= 1 && line[1] > 190 && line[1] < 220;
        System.out.println("live: " + (line == null ? "null" : ((line.length - 1) / 3) + " points, " + (int) line[0] + " settled, first x " + line[1]));
        boolean ok = liveOk && info.contains("\"geometry\"") && geo.contains("\"strokes\"") && !geo.contains("error") && bad.contains("error");
        System.out.println(ok ? "JNI OK" : "JNI WRONG");
        if (!ok) System.exit(1);
    }
}
