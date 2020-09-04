import Combine
import TinyNetworking

public final class BusStopService {
  private let network = TinyNetworking<BusStopServiceTask>()
  public let busStopSubject = PassthroughSubject<BusStopPayload, TinyNetworkingError>()
  private var disposables: Set<AnyCancellable> = []
  public init() {}
  
  public func loadBusStops(page: Int) -> AnyPublisher<BusStopPayload, TinyNetworkingError> {
    return network
      .requestPublisher(resource: .busStops(page: page))
      .map(to: BusStopPayload.self)
  }
  
  public func loadAllBusStops() -> PassthroughSubject<BusStopPayload, TinyNetworkingError> {
    func recursePage(_ page: Int, aggregatedPayload: BusStopPayload) {
      loadBusStops(page: page)
        .sink(receiveCompletion: { _ in
      }) { [weak self] payload in
        guard let self = self else {
          return
        }
        
        if payload.value.count >= 500 {
          let aggregatedPayloadValue = aggregatedPayload.value
          let newPayloadValue = aggregatedPayloadValue + payload.value
          recursePage(page + 1, aggregatedPayload: BusStopPayload(value: newPayloadValue))
        } else {
          let aggregatedPayloadValue = aggregatedPayload.value
          let newPayloadValue = aggregatedPayloadValue + payload.value
          let payload = BusStopPayload(value: newPayloadValue)
          self.busStopSubject.send(payload)
        }
      }.store(in: &disposables)
    }
    recursePage(1, aggregatedPayload: BusStopPayload(value: []))
    
    return busStopSubject
  }
}
