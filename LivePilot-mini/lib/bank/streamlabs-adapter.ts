import type { ChatAnnouncement } from "../automation/streamlabs-matcher";
import { parseHeistCaptain, parseHeistJoin, parseHeistResults } from "../automation/streamlabs-intelligence";
import { initializeBank } from "./worker";
import { RoundService } from "./rounds";

export async function captureBankRound(stream:string,message:ChatAnnouncement,confirmedStake?:number){
 if(!parseHeistCaptain(message.text)&&!parseHeistJoin(message.text)&&!parseHeistResults(message.text))return;
 const {l,config}=await initializeBank();
 // A configured stream identifies the economy being monitored. Cross-economy
 // observations must never modify this book.
 if(config.youtubeUrl!==stream)return;
 new RoundService(l).observe(stream,config.economy,message,confirmedStake);
}
