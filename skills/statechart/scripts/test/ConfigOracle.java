import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.Hashtable;
import java.util.Map;
import java.util.StringJoiner;
import java.util.TreeMap;
import tlc2.tool.impl.ModelConfig;
import tlc2.util.Vect;
import util.SimpleFilenameToStream;

public class ConfigOracle {
  static String json(Object v) {
    if (v instanceof Boolean) return v.toString();
    if (v instanceof Vect) {
      Vect<?> vect = (Vect<?>) v;
      StringJoiner out = new StringJoiner(",", "[", "]");
      for (int i = 0; i < vect.size(); i++) out.add(json(vect.elementAt(i)));
      return out.toString();
    }
    if (v instanceof Hashtable) {
      StringJoiner out = new StringJoiner(",", "{", "}");
      for (Map.Entry<String, Object> e : sorted((Hashtable<?, ?>) v).entrySet())
        out.add(json(e.getKey()) + ":" + json(e.getValue()));
      return out.toString();
    }
    StringBuilder b = new StringBuilder("\"");
    for (char c : String.valueOf(v).toCharArray())
      b.append(c == '"' || c == '\\' ? "\\" + c : c < 0x20 || c > 0x7e ? String.format("\\u%04x", (int) c) : c);
    return b.append('"').toString();
  }

  static TreeMap<String, Object> sorted(Hashtable<?, ?> table) {
    TreeMap<String, Object> out = new TreeMap<>();
    for (Map.Entry<?, ?> e : table.entrySet()) out.put(e.getKey().toString(), e.getValue());
    return out;
  }

  public static void main(String[] args) throws Exception {
    Field table = ModelConfig.class.getDeclaredField("configTbl");
    table.setAccessible(true);
    // TLC keeps the comment depth in a static field and never resets it, so a config that ends
    // inside a nested comment would change how the next config in this JVM reads.
    Field depth = Class.forName("tla2sany.parser.TLAplusParserTokenManager").getDeclaredField("bracketCount");
    depth.setAccessible(true);
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String file; (file = in.readLine()) != null; ) {
      String out;
      try {
        depth.setInt(null, 0);
        ModelConfig config = new ModelConfig(file, new SimpleFilenameToStream());
        config.parse();
        out = "{\"table\":" + json(table.get(config)) + ",\"overrides\":" + json(config.getOverrides())
            + ",\"modConstants\":" + json(config.getModConstants()) + ",\"modOverrides\":" + json(config.getModOverrides())
            + ",\"deadlock\":" + config.getCheckDeadlock() + "}";
      } catch (Throwable e) {
        out = "{\"error\":" + json(e.getClass().getSimpleName() + ": " + e.getMessage()) + "}";
      }
      System.out.println(out);
    }
  }
}
