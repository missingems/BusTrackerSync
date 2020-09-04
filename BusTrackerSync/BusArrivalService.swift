import Combine
import TinyNetworking

public final class BusArrivalService {
  private let network = TinyNetworking<BusArrivalServiceTask>()
  
  public init() {}
  
  public func loadBusArrival(busStopCode: String) -> AnyPublisher<BusArrivalPayload, TinyNetworkingError> {
    return network
      .requestPublisher(resource: .busArrival(busStopCode: busStopCode))
      .map(to: BusArrivalPayload.self)
  }
}
