import { useAppController } from "@/useAppController";
import { AppView } from "@/AppView";

export default function App() {
  const controller = useAppController();
  return <AppView {...controller} />;
}
