use opennote_native::call;
use serde_json::Value;

#[test]
fn test_mirror_lifecycle_through_bridge() {
    // 1. Initial status should be inactive
    let (meta, _) = call("mirrorStatus", "", &[]).expect("mirrorStatus");
    let v: Value = serde_json::from_str(&meta).expect("parse json");
    assert_eq!(v["active"], false);

    // 2. Start mirroring (with port 0 or custom port to avoid any conflict)
    let (meta, _) =
        call("mirrorStart", r#"{"port": 38400, "pin": "8492"}"#, &[]).expect("mirrorStart");
    let v: Value = serde_json::from_str(&meta).expect("parse json");
    assert_eq!(v["active"], true);
    assert_eq!(v["pin"], "8492");
    let port = v["port"].as_u64().expect("port");
    assert!(port >= 38400);

    // 3. Status should now be active
    let (meta, _) = call("mirrorStatus", "", &[]).expect("mirrorStatus");
    let v: Value = serde_json::from_str(&meta).expect("parse json");
    assert_eq!(v["active"], true);
    assert_eq!(v["pin"], "8492");

    // 4. Stop mirroring
    let (meta, _) = call("mirrorStop", "", &[]).expect("mirrorStop");
    let v: Value = serde_json::from_str(&meta).expect("parse json");
    assert_eq!(v["active"], false);

    // 5. Status should be inactive again
    let (meta, _) = call("mirrorStatus", "", &[]).expect("mirrorStatus");
    let v: Value = serde_json::from_str(&meta).expect("parse json");
    assert_eq!(v["active"], false);
}
