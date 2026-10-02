import { Navigation, Script } from "scripting"
import { App } from "./src/ui/app"

async function run() {
  try {
    if (Script.supportsMinimization()) Script.enableMinimize()
    await Navigation.present<"close" | undefined>({
      element: <App />,
      modalPresentationStyle: "overFullScreen",
    })
  } catch (error) {
    console.error(error)
    await console.present()
  } finally {
    Script.exit()
  }
}

run()
