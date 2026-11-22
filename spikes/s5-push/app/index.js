// Spike S5's entry: the random source first, then the background handlers, then the screen.
import "./src/random";
import { AppRegistry } from "react-native";
import { registerRootComponent } from "expo";
import { runDisarm, startBackground } from "./src/background";
import App from "./App";

startBackground();
AppRegistry.registerHeadlessTask("HsnDisarm", () => (data) => runDisarm(data));
registerRootComponent(App);
