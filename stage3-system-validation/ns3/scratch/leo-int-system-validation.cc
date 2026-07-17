#include "ns3/core-module.h"
#include "ns3/internet-module.h"
#include "ns3/network-module.h"
#include "ns3/point-to-point-module.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <map>
#include <numeric>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using namespace ns3;

NS_LOG_COMPONENT_DEFINE("LeoIntSystemValidation");

namespace
{

using CsvRow = std::map<std::string, std::string>;

std::vector<std::string>
SplitCsvLine(const std::string& line)
{
    std::vector<std::string> cells;
    std::string cell;
    bool quoted = false;
    for (std::size_t i = 0; i < line.size(); ++i)
    {
        const char value = line[i];
        if (value == '"')
        {
            if (quoted && i + 1 < line.size() && line[i + 1] == '"')
            {
                cell.push_back('"');
                ++i;
            }
            else
            {
                quoted = !quoted;
            }
        }
        else if (value == ',' && !quoted)
        {
            cells.push_back(cell);
            cell.clear();
        }
        else
        {
            cell.push_back(value);
        }
    }
    cells.push_back(cell);
    return cells;
}

std::vector<CsvRow>
ReadCsv(const std::string& path)
{
    std::ifstream input(path);
    if (!input.is_open())
    {
        throw std::runtime_error("Unable to open CSV: " + path);
    }
    std::string line;
    if (!std::getline(input, line))
    {
        return {};
    }
    if (!line.empty() && line.back() == '\r')
    {
        line.pop_back();
    }
    const auto headers = SplitCsvLine(line);
    std::vector<CsvRow> rows;
    while (std::getline(input, line))
    {
        if (!line.empty() && line.back() == '\r')
        {
            line.pop_back();
        }
        if (line.empty())
        {
            continue;
        }
        const auto values = SplitCsvLine(line);
        CsvRow row;
        for (std::size_t index = 0; index < headers.size(); ++index)
        {
            row[headers[index]] = index < values.size() ? values[index] : "";
        }
        rows.push_back(std::move(row));
    }
    return rows;
}

std::vector<std::string>
SplitPipe(const std::string& value)
{
    std::vector<std::string> output;
    std::stringstream stream(value);
    std::string item;
    while (std::getline(stream, item, '|'))
    {
        if (!item.empty())
        {
            output.push_back(item);
        }
    }
    return output;
}

double
ToDouble(const std::string& value, double fallback = 0.0)
{
    if (value.empty())
    {
        return fallback;
    }
    try
    {
        return std::stod(value);
    }
    catch (...)
    {
        return fallback;
    }
}

uint32_t
ToUint(const std::string& value, uint32_t fallback = 0)
{
    return static_cast<uint32_t>(std::max(0.0, ToDouble(value, fallback)));
}

bool
ToBool(const std::string& value)
{
    std::string normalized = value;
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return normalized == "true" || normalized == "1";
}

std::string
EndpointKey(const std::string& left, const std::string& right)
{
    return left < right ? left + "<->" + right : right + "<->" + left;
}

double
Percentile(std::vector<double> values, double probability)
{
    if (values.empty())
    {
        return 0.0;
    }
    std::sort(values.begin(), values.end());
    const double position = std::max(0.0, std::min(static_cast<double>(values.size() - 1),
                                                   probability * (values.size() - 1)));
    const auto lower = static_cast<std::size_t>(std::floor(position));
    const auto upper = static_cast<std::size_t>(std::ceil(position));
    if (lower == upper)
    {
        return values[lower];
    }
    const double weight = position - lower;
    return values[lower] * (1.0 - weight) + values[upper] * weight;
}

class PathPacketHeader : public Header
{
  public:
    PathPacketHeader() = default;

    static TypeId GetTypeId()
    {
        static TypeId tid = TypeId("ns3::PathPacketHeader")
                                .SetParent<Header>()
                                .AddConstructor<PathPacketHeader>();
        return tid;
    }

    TypeId GetInstanceTypeId() const override
    {
        return GetTypeId();
    }

    uint32_t GetSerializedSize() const override
    {
        return 24;
    }

    void Serialize(Buffer::Iterator start) const override
    {
        start.WriteHtonU32(m_pathId);
        start.WriteHtonU32(m_sequence);
        start.WriteHtonU32(m_hopIndex);
        start.WriteU8(m_kind);
        start.WriteU8(m_direction > 0 ? 1 : 0);
        start.WriteHtonU16(0);
        start.WriteHtonU32(static_cast<uint32_t>(m_createdNs >> 32));
        start.WriteHtonU32(static_cast<uint32_t>(m_createdNs & 0xffffffff));
    }

    uint32_t Deserialize(Buffer::Iterator start) override
    {
        m_pathId = start.ReadNtohU32();
        m_sequence = start.ReadNtohU32();
        m_hopIndex = start.ReadNtohU32();
        m_kind = start.ReadU8();
        m_direction = start.ReadU8() == 1 ? 1 : -1;
        start.ReadNtohU16();
        const uint64_t high = start.ReadNtohU32();
        const uint64_t low = start.ReadNtohU32();
        m_createdNs = (high << 32) | low;
        return GetSerializedSize();
    }

    void Print(std::ostream& os) const override
    {
        os << "path=" << m_pathId << " seq=" << m_sequence << " hop=" << m_hopIndex;
    }

    uint32_t m_pathId{0};
    uint32_t m_sequence{0};
    uint32_t m_hopIndex{0};
    uint8_t m_kind{0}; // 0 business, 1 probe/report
    int8_t m_direction{1};
    uint64_t m_createdNs{0};
};

struct PathSpec
{
    uint32_t id{0};
    std::string externalId;
    bool probe{false};
    std::vector<uint32_t> nodes;
    std::vector<uint32_t> metadataBytes;
    double startSeconds{0.0};
    double stopSeconds{0.0};
    double intervalSeconds{0.0};
    uint32_t basePacketBytes{0};
    uint32_t payloadBytes{0};
};

struct LinkState
{
    uint32_t slice{0};
    std::string linkId;
    std::string source;
    std::string target;
    bool active{false};
    double delayMs{0.0};
    double dataRateMbps{50.0};
    double packetErrorRate{0.0};
};

struct LinkRuntime
{
    std::string endpointKey;
    std::string leftId;
    std::string rightId;
    Ptr<PointToPointNetDevice> leftDevice;
    Ptr<PointToPointNetDevice> rightDevice;
    Ptr<PointToPointChannel> channel;
    Ptr<RateErrorModel> leftError;
    Ptr<RateErrorModel> rightError;
    bool active{false};
};

struct DirectedEndpoint
{
    Ipv4Address neighborAddress;
    LinkRuntime* runtime{nullptr};
};

struct Metrics
{
    uint64_t businessSent{0};
    uint64_t businessDelivered{0};
    uint64_t businessPayloadDelivered{0};
    uint64_t probeSent{0};
    uint64_t reportDelivered{0};
    uint64_t businessNetworkBytes{0};
    uint64_t telemetryNetworkBytes{0};
    uint64_t attemptedTelemetryNetworkBytes{0};
    uint64_t plannedTelemetryNetworkBytes{0};
    uint64_t metadataGeneratedBytes{0};
    uint64_t mtuDrops{0};
    uint64_t linkDownDrops{0};
    uint64_t deviceQueueDrops{0};
    uint32_t maxWirePacketBytes{0};
    std::vector<double> businessDelaysMs;
    std::vector<double> reportRttsMs;
    std::vector<double> queueDelaysMs;
    std::vector<double> businessQueueDelaysMs;
    std::vector<double> telemetryQueueDelaysMs;
};

struct ReportUpdate
{
    uint32_t pathId{0};
    double generatedSeconds{0.0};
    double deliveredSeconds{0.0};
};

class PacketForwarder;

class ValidationExperiment
{
  public:
    void Configure(const std::string& inputDir,
                   const std::string& outputPath,
                   const std::string& variant,
                   double loadScale,
                   uint32_t seed,
                   uint32_t sliceCount,
                   double sliceDuration,
                   uint32_t mtuBytes,
                   uint32_t queuePackets,
                   uint32_t ipUdpOverhead,
                   double reportTimeout);
    void Build();
    void Run();
    void HandlePacket(uint32_t nodeIndex, Ptr<Packet> packet);
    void Inject(uint32_t pathId, uint32_t sequence);
    void OnDeviceQueueEnqueue(Ptr<const Packet> packet);
    void OnDeviceQueueDequeue(Ptr<const Packet> packet);
    void OnDeviceQueueDrop(Ptr<const Packet> packet);

  private:
    friend class PacketForwarder;
    void ReadInputs();
    void BuildNetwork();
    void BuildApplications();
    void ScheduleTraffic();
    void ApplySlice(uint32_t sliceIndex);
    void Forward(uint32_t nodeIndex, Ptr<Packet> payload, PathPacketHeader header);
    void WriteResult() const;
    uint64_t PlannedBytesPerProbe(const PathSpec& path) const;
    std::pair<double, double> ComputeOamAoiMs() const;

    std::string m_inputDir;
    std::string m_outputPath;
    std::string m_variant;
    double m_loadScale{1.0};
    uint32_t m_seed{11};
    uint32_t m_sliceCount{20};
    double m_sliceDuration{1.0};
    uint32_t m_mtuBytes{1500};
    uint32_t m_queuePackets{100};
    uint32_t m_ipUdpOverhead{28};
    double m_reportTimeout{2.0};
    uint16_t m_port{39013};
    NodeContainer m_nodes;
    std::vector<std::string> m_nodeIds;
    std::map<std::string, uint32_t> m_nodeIndex;
    std::map<uint32_t, PathSpec> m_paths;
    std::vector<LinkState> m_linkStates;
    std::map<std::string, LinkRuntime> m_linkRuntimes;
    std::map<std::pair<uint32_t, uint32_t>, DirectedEndpoint> m_directedEndpoints;
    std::vector<Ptr<PacketForwarder>> m_forwarders;
    std::map<uint64_t, int64_t> m_queueEnqueueNs;
    std::map<uint64_t, bool> m_packetIsTelemetry;
    std::vector<ReportUpdate> m_reportUpdates;
    Metrics m_metrics;
};

class PacketForwarder : public Application
{
  public:
    void Configure(ValidationExperiment* experiment, uint32_t nodeIndex, uint16_t port)
    {
        m_experiment = experiment;
        m_nodeIndex = nodeIndex;
        m_port = port;
    }

    int Send(Ptr<Packet> packet, Ipv4Address address)
    {
        return m_socket->SendTo(packet, 0, InetSocketAddress(address, m_port));
    }

  private:
    void StartApplication() override
    {
        m_socket = Socket::CreateSocket(GetNode(), UdpSocketFactory::GetTypeId());
        if (m_socket->Bind(InetSocketAddress(Ipv4Address::GetAny(), m_port)) < 0)
        {
            throw std::runtime_error("Unable to bind packet forwarder socket");
        }
        m_socket->SetRecvCallback(MakeCallback(&PacketForwarder::HandleRead, this));
    }

    void StopApplication() override
    {
        if (m_socket)
        {
            m_socket->Close();
        }
    }

    void HandleRead(Ptr<Socket> socket)
    {
        Address source;
        while (Ptr<Packet> packet = socket->RecvFrom(source))
        {
            m_experiment->HandlePacket(m_nodeIndex, packet);
        }
    }

    ValidationExperiment* m_experiment{nullptr};
    uint32_t m_nodeIndex{0};
    uint16_t m_port{0};
    Ptr<Socket> m_socket;
};

void
ValidationExperiment::Configure(const std::string& inputDir,
                                const std::string& outputPath,
                                const std::string& variant,
                                double loadScale,
                                uint32_t seed,
                                uint32_t sliceCount,
                                double sliceDuration,
                                uint32_t mtuBytes,
                                uint32_t queuePackets,
                                uint32_t ipUdpOverhead,
                                double reportTimeout)
{
    m_inputDir = inputDir;
    m_outputPath = outputPath;
    m_variant = variant;
    m_loadScale = loadScale;
    m_seed = seed;
    m_sliceCount = sliceCount;
    m_sliceDuration = sliceDuration;
    m_mtuBytes = mtuBytes;
    m_queuePackets = queuePackets;
    m_ipUdpOverhead = ipUdpOverhead;
    m_reportTimeout = reportTimeout;
}

void
ValidationExperiment::ReadInputs()
{
    for (const auto& row : ReadCsv(m_inputDir + "/nodes.csv"))
    {
        const uint32_t index = ToUint(row.at("node_index"));
        if (m_nodeIds.size() <= index)
        {
            m_nodeIds.resize(index + 1);
        }
        m_nodeIds[index] = row.at("node_id");
        m_nodeIndex[row.at("node_id")] = index;
    }

    for (const auto& row : ReadCsv(m_inputDir + "/links.csv"))
    {
        LinkState state;
        state.slice = ToUint(row.at("slice_index"));
        state.linkId = row.at("link_id");
        state.source = row.at("source");
        state.target = row.at("target");
        state.active = ToBool(row.at("is_active"));
        state.delayMs = ToDouble(row.at("delay_ms"));
        state.dataRateMbps = std::max(0.001, ToDouble(row.at("data_rate_mbps"), 50.0));
        state.packetErrorRate = std::max(0.0, std::min(1.0, ToDouble(row.at("packet_error_rate"))));
        m_linkStates.push_back(std::move(state));
    }

    uint32_t pathId = 0;
    for (const auto& row : ReadCsv(m_inputDir + "/business-flows.csv"))
    {
        PathSpec path;
        path.id = pathId++;
        path.externalId = row.at("flow_id");
        path.probe = false;
        for (const auto& nodeId : SplitPipe(row.at("path_nodes")))
        {
            path.nodes.push_back(m_nodeIndex.at(nodeId));
        }
        path.startSeconds = ToDouble(row.at("start_s"));
        path.stopSeconds = ToDouble(row.at("stop_s"));
        path.basePacketBytes = ToUint(row.at("packet_size_bytes"));
        path.payloadBytes = path.basePacketBytes;
        const double rateMbps = std::max(0.001, ToDouble(row.at("base_rate_mbps")) * m_loadScale);
        path.intervalSeconds = path.basePacketBytes * 8.0 / (rateMbps * 1e6);
        m_paths[path.id] = std::move(path);
    }
    if (m_variant != "no-int")
    {
        for (const auto& row : ReadCsv(m_inputDir + "/probe-flows.csv"))
        {
            if (row.at("variant") != m_variant)
            {
                continue;
            }
            PathSpec path;
            path.id = pathId++;
            path.externalId = row.at("probe_id");
            path.probe = true;
            for (const auto& nodeId : SplitPipe(row.at("path_nodes")))
            {
                path.nodes.push_back(m_nodeIndex.at(nodeId));
            }
            for (const auto& value : SplitPipe(row.at("metadata_bytes_by_hop")))
            {
                path.metadataBytes.push_back(ToUint(value));
            }
            path.startSeconds = ToDouble(row.at("start_s"));
            path.stopSeconds = ToDouble(row.at("stop_s"));
            path.intervalSeconds = ToDouble(row.at("interval_ms")) / 1000.0;
            path.basePacketBytes = ToUint(row.at("base_packet_bytes"));
            path.payloadBytes = 0;
            m_paths[path.id] = std::move(path);
        }
    }
}

void
ValidationExperiment::BuildNetwork()
{
    m_nodes.Create(m_nodeIds.size());
    InternetStackHelper internet;
    internet.Install(m_nodes);

    std::set<std::string> endpoints;
    for (const auto& state : m_linkStates)
    {
        endpoints.insert(EndpointKey(state.source, state.target));
    }
    uint32_t subnetIndex = 1;
    for (const auto& key : endpoints)
    {
        const auto separator = key.find("<->");
        const std::string leftId = key.substr(0, separator);
        const std::string rightId = key.substr(separator + 3);
        const uint32_t left = m_nodeIndex.at(leftId);
        const uint32_t right = m_nodeIndex.at(rightId);

        PointToPointHelper helper;
        helper.SetDeviceAttribute("DataRate", StringValue("50Mbps"));
        helper.SetChannelAttribute("Delay", TimeValue(MilliSeconds(1)));
        helper.SetQueue("ns3::DropTailQueue<Packet>",
                        "MaxSize",
                        QueueSizeValue(QueueSize(std::to_string(m_queuePackets) + "p")));
        NetDeviceContainer devices = helper.Install(m_nodes.Get(left), m_nodes.Get(right));

        std::ostringstream network;
        network << "10." << ((subnetIndex / 256) % 256) << "." << (subnetIndex % 256) << ".0";
        Ipv4AddressHelper address;
        address.SetBase(network.str().c_str(), "255.255.255.252");
        Ipv4InterfaceContainer interfaces = address.Assign(devices);
        ++subnetIndex;

        LinkRuntime runtime;
        runtime.endpointKey = key;
        runtime.leftId = leftId;
        runtime.rightId = rightId;
        runtime.leftDevice = DynamicCast<PointToPointNetDevice>(devices.Get(0));
        runtime.rightDevice = DynamicCast<PointToPointNetDevice>(devices.Get(1));
        runtime.channel = DynamicCast<PointToPointChannel>(runtime.leftDevice->GetChannel());
        runtime.leftError = CreateObject<RateErrorModel>();
        runtime.rightError = CreateObject<RateErrorModel>();
        runtime.leftError->SetUnit(RateErrorModel::ERROR_UNIT_PACKET);
        runtime.rightError->SetUnit(RateErrorModel::ERROR_UNIT_PACKET);
        runtime.leftDevice->SetReceiveErrorModel(runtime.leftError);
        runtime.rightDevice->SetReceiveErrorModel(runtime.rightError);
        runtime.leftDevice->GetQueue()->TraceConnectWithoutContext(
            "Enqueue",
            MakeCallback(&ValidationExperiment::OnDeviceQueueEnqueue, this));
        runtime.leftDevice->GetQueue()->TraceConnectWithoutContext(
            "Dequeue",
            MakeCallback(&ValidationExperiment::OnDeviceQueueDequeue, this));
        runtime.leftDevice->GetQueue()->TraceConnectWithoutContext(
            "Drop",
            MakeCallback(&ValidationExperiment::OnDeviceQueueDrop, this));
        runtime.rightDevice->GetQueue()->TraceConnectWithoutContext(
            "Enqueue",
            MakeCallback(&ValidationExperiment::OnDeviceQueueEnqueue, this));
        runtime.rightDevice->GetQueue()->TraceConnectWithoutContext(
            "Dequeue",
            MakeCallback(&ValidationExperiment::OnDeviceQueueDequeue, this));
        runtime.rightDevice->GetQueue()->TraceConnectWithoutContext(
            "Drop",
            MakeCallback(&ValidationExperiment::OnDeviceQueueDrop, this));
        m_linkRuntimes[key] = runtime;
        LinkRuntime* stored = &m_linkRuntimes.at(key);
        m_directedEndpoints[{left, right}] = {interfaces.GetAddress(1), stored};
        m_directedEndpoints[{right, left}] = {interfaces.GetAddress(0), stored};
    }
}

void
ValidationExperiment::BuildApplications()
{
    m_forwarders.resize(m_nodes.GetN());
    for (uint32_t index = 0; index < m_nodes.GetN(); ++index)
    {
        Ptr<PacketForwarder> app = CreateObject<PacketForwarder>();
        app->Configure(this, index, m_port);
        m_nodes.Get(index)->AddApplication(app);
        app->SetStartTime(Seconds(0));
        app->SetStopTime(Seconds(m_sliceCount * m_sliceDuration + m_reportTimeout));
        m_forwarders[index] = app;
    }
}

uint64_t
ValidationExperiment::PlannedBytesPerProbe(const PathSpec& path) const
{
    uint64_t size = path.basePacketBytes;
    uint64_t planned = 0;
    for (std::size_t index = 0; index + 1 < path.nodes.size(); ++index)
    {
        size += index < path.metadataBytes.size() ? path.metadataBytes[index] : 0;
        planned += size + m_ipUdpOverhead;
    }
    if (!path.nodes.empty())
    {
        const std::size_t sink = path.nodes.size() - 1;
        size += sink < path.metadataBytes.size() ? path.metadataBytes[sink] : 0;
        planned += sink * (size + m_ipUdpOverhead);
    }
    return planned;
}

void
ValidationExperiment::ScheduleTraffic()
{
    for (const auto& [pathId, path] : m_paths)
    {
        uint32_t sequence = 0;
        for (double time = path.startSeconds; time < path.stopSeconds - 1e-12;
             time += path.intervalSeconds)
        {
            Simulator::Schedule(Seconds(time), &ValidationExperiment::Inject, this, pathId, sequence++);
            if (path.probe)
            {
                m_metrics.plannedTelemetryNetworkBytes += PlannedBytesPerProbe(path);
            }
        }
    }
}

void
ValidationExperiment::ApplySlice(uint32_t sliceIndex)
{
    std::map<std::string, const LinkState*> stateByEndpoint;
    for (const auto& state : m_linkStates)
    {
        if (state.slice == sliceIndex)
        {
            stateByEndpoint[EndpointKey(state.source, state.target)] = &state;
        }
    }
    for (auto& [key, runtime] : m_linkRuntimes)
    {
        const auto found = stateByEndpoint.find(key);
        if (found == stateByEndpoint.end() || !found->second->active)
        {
            runtime.active = false;
            runtime.leftError->SetRate(1.0);
            runtime.rightError->SetRate(1.0);
            continue;
        }
        const LinkState& state = *found->second;
        runtime.active = true;
        const DataRate rate(static_cast<uint64_t>(state.dataRateMbps * 1e6));
        runtime.leftDevice->SetDataRate(rate);
        runtime.rightDevice->SetDataRate(rate);
        runtime.channel->SetAttribute("Delay", TimeValue(MilliSeconds(state.delayMs)));
        runtime.leftError->SetRate(state.packetErrorRate);
        runtime.rightError->SetRate(state.packetErrorRate);
    }
}

void
ValidationExperiment::Inject(uint32_t pathId, uint32_t sequence)
{
    const PathSpec& path = m_paths.at(pathId);
    PathPacketHeader header;
    header.m_pathId = pathId;
    header.m_sequence = sequence;
    header.m_hopIndex = 0;
    header.m_kind = path.probe ? 1 : 0;
    header.m_direction = 1;
    header.m_createdNs = Simulator::Now().GetNanoSeconds();
    const uint32_t bodyBytes = path.basePacketBytes > header.GetSerializedSize()
                                   ? path.basePacketBytes - header.GetSerializedSize()
                                   : 0;
    Ptr<Packet> payload = Create<Packet>(bodyBytes);
    if (path.probe)
    {
        ++m_metrics.probeSent;
    }
    else
    {
        ++m_metrics.businessSent;
    }
    Forward(path.nodes.front(), payload, header);
}

void
ValidationExperiment::HandlePacket(uint32_t nodeIndex, Ptr<Packet> packet)
{
    PathPacketHeader header;
    packet->RemoveHeader(header);
    if (header.m_direction > 0)
    {
        ++header.m_hopIndex;
    }
    else
    {
        --header.m_hopIndex;
    }
    Forward(nodeIndex, packet, header);
}

void
ValidationExperiment::Forward(uint32_t nodeIndex, Ptr<Packet> payload, PathPacketHeader header)
{
    const PathSpec& path = m_paths.at(header.m_pathId);
    const uint32_t last = static_cast<uint32_t>(path.nodes.size() - 1);
    if (path.probe && header.m_direction > 0)
    {
        const uint32_t metadata = header.m_hopIndex < path.metadataBytes.size()
                                      ? path.metadataBytes[header.m_hopIndex]
                                      : 0;
        if (metadata > 0)
        {
            payload->AddAtEnd(Create<Packet>(metadata));
            m_metrics.metadataGeneratedBytes += metadata;
        }
    }

    if (!path.probe && header.m_hopIndex == last)
    {
        ++m_metrics.businessDelivered;
        m_metrics.businessPayloadDelivered += path.payloadBytes;
        m_metrics.businessDelaysMs.push_back(
            (Simulator::Now().GetNanoSeconds() - header.m_createdNs) / 1e6);
        return;
    }
    if (path.probe && header.m_direction > 0 && header.m_hopIndex == last)
    {
        header.m_direction = -1;
    }
    else if (path.probe && header.m_direction < 0 && header.m_hopIndex == 0)
    {
        ++m_metrics.reportDelivered;
        const double deliveredSeconds = Simulator::Now().GetSeconds();
        const double generatedSeconds = header.m_createdNs / 1e9;
        m_metrics.reportRttsMs.push_back((deliveredSeconds - generatedSeconds) * 1000.0);
        m_reportUpdates.push_back({header.m_pathId, generatedSeconds, deliveredSeconds});
        return;
    }

    const int64_t nextSigned = static_cast<int64_t>(header.m_hopIndex) + header.m_direction;
    if (nextSigned < 0 || nextSigned > last)
    {
        ++m_metrics.linkDownDrops;
        return;
    }
    const uint32_t next = static_cast<uint32_t>(nextSigned);
    const auto endpoint = m_directedEndpoints.find({nodeIndex, path.nodes[next]});
    if (endpoint == m_directedEndpoints.end() || !endpoint->second.runtime->active)
    {
        ++m_metrics.linkDownDrops;
        return;
    }

    Ptr<Packet> wirePacket = payload->Copy();
    wirePacket->AddHeader(header);
    const uint32_t wireBytes = wirePacket->GetSize() + m_ipUdpOverhead;
    m_metrics.maxWirePacketBytes = std::max(m_metrics.maxWirePacketBytes, wireBytes);
    if (path.probe)
    {
        m_metrics.attemptedTelemetryNetworkBytes += wireBytes;
    }
    if (wireBytes > m_mtuBytes)
    {
        ++m_metrics.mtuDrops;
        return;
    }
    if (path.probe)
    {
        m_metrics.telemetryNetworkBytes += wireBytes;
    }
    else
    {
        m_metrics.businessNetworkBytes += wireBytes;
    }
    m_packetIsTelemetry[wirePacket->GetUid()] = path.probe;
    const int sent = m_forwarders[nodeIndex]->Send(wirePacket, endpoint->second.neighborAddress);
    if (sent < 0)
    {
        m_packetIsTelemetry.erase(wirePacket->GetUid());
        m_queueEnqueueNs.erase(wirePacket->GetUid());
        ++m_metrics.linkDownDrops;
    }
}

void
ValidationExperiment::OnDeviceQueueEnqueue(Ptr<const Packet> packet)
{
    m_queueEnqueueNs[packet->GetUid()] = Simulator::Now().GetNanoSeconds();
}

void
ValidationExperiment::OnDeviceQueueDequeue(Ptr<const Packet> packet)
{
    const uint64_t uid = packet->GetUid();
    const auto enqueued = m_queueEnqueueNs.find(uid);
    if (enqueued != m_queueEnqueueNs.end())
    {
        const double delayMs = (Simulator::Now().GetNanoSeconds() - enqueued->second) / 1e6;
        m_metrics.queueDelaysMs.push_back(delayMs);
        const auto kind = m_packetIsTelemetry.find(uid);
        if (kind != m_packetIsTelemetry.end() && kind->second)
        {
            m_metrics.telemetryQueueDelaysMs.push_back(delayMs);
        }
        else
        {
            m_metrics.businessQueueDelaysMs.push_back(delayMs);
        }
    }
    m_queueEnqueueNs.erase(uid);
    m_packetIsTelemetry.erase(uid);
}

void
ValidationExperiment::OnDeviceQueueDrop(Ptr<const Packet> packet)
{
    m_queueEnqueueNs.erase(packet->GetUid());
    m_packetIsTelemetry.erase(packet->GetUid());
    ++m_metrics.deviceQueueDrops;
}

void
ValidationExperiment::Build()
{
    ReadInputs();
    BuildNetwork();
    BuildApplications();
    for (uint32_t slice = 0; slice < m_sliceCount; ++slice)
    {
        Simulator::Schedule(Seconds(slice * m_sliceDuration),
                            &ValidationExperiment::ApplySlice,
                            this,
                            slice);
    }
    ScheduleTraffic();
}

std::pair<double, double>
ValidationExperiment::ComputeOamAoiMs() const
{
    std::map<uint32_t, std::vector<ReportUpdate>> updatesByPath;
    for (const auto& update : m_reportUpdates)
    {
        updatesByPath[update.pathId].push_back(update);
    }

    double totalAreaSecondsSquared = 0.0;
    double totalDurationSeconds = 0.0;
    std::vector<double> peakAoiMs;
    const double simulationEnd = m_sliceCount * m_sliceDuration + m_reportTimeout;
    for (const auto& [pathId, path] : m_paths)
    {
        if (!path.probe)
        {
            continue;
        }
        const double start = path.startSeconds;
        const double end = std::min(simulationEnd, path.stopSeconds + m_reportTimeout);
        if (end <= start)
        {
            continue;
        }

        double lastTime = start;
        double lastGeneration = start;
        auto updates = updatesByPath[pathId];
        std::sort(updates.begin(), updates.end(), [](const auto& left, const auto& right) {
            return left.deliveredSeconds < right.deliveredSeconds;
        });
        for (const auto& update : updates)
        {
            if (update.deliveredSeconds < start || update.deliveredSeconds > end ||
                update.generatedSeconds < lastGeneration)
            {
                continue;
            }
            const double oldStartAge = std::max(0.0, lastTime - lastGeneration);
            const double oldEndAge = std::max(0.0, update.deliveredSeconds - lastGeneration);
            totalAreaSecondsSquared +=
                0.5 * (oldEndAge * oldEndAge - oldStartAge * oldStartAge);
            peakAoiMs.push_back(oldEndAge * 1000.0);
            lastTime = update.deliveredSeconds;
            lastGeneration = update.generatedSeconds;
        }
        const double finalStartAge = std::max(0.0, lastTime - lastGeneration);
        const double finalEndAge = std::max(0.0, end - lastGeneration);
        totalAreaSecondsSquared +=
            0.5 * (finalEndAge * finalEndAge - finalStartAge * finalStartAge);
        peakAoiMs.push_back(finalEndAge * 1000.0);
        totalDurationSeconds += end - start;
    }

    const double averageAoiMs = totalDurationSeconds > 0.0
                                    ? totalAreaSecondsSquared / totalDurationSeconds * 1000.0
                                    : 0.0;
    return {averageAoiMs, Percentile(peakAoiMs, 0.95)};
}

void
ValidationExperiment::WriteResult() const
{
    const double duration = m_sliceCount * m_sliceDuration;
    const double businessDeliveryRatio = static_cast<double>(m_metrics.businessDelivered) /
                                         std::max<uint64_t>(1, m_metrics.businessSent);
    const double throughputMbps = m_metrics.businessPayloadDelivered * 8.0 / (duration * 1e6);
    const double reportDeliveryRatio = m_variant == "no-int"
                                           ? 0.0
                                           : static_cast<double>(m_metrics.reportDelivered) /
                                                 std::max<uint64_t>(1, m_metrics.probeSent);
    const auto [averageAoiMs, peakAoiP95Ms] = ComputeOamAoiMs();
    std::ofstream output(m_outputPath);
    if (!output.is_open())
    {
        throw std::runtime_error("Unable to write result: " + m_outputPath);
    }
    output << "engine,evidence_role,mtu_policy,variant,load_scale,seed,business_sent_packets,"
              "business_delivered_packets,business_delivery_ratio,business_throughput_mbps,"
              "business_delay_p50_ms,business_delay_p95_ms,queue_delay_p95_ms,"
              "business_queue_delay_p95_ms,telemetry_queue_delay_p95_ms,probe_sent_packets,"
              "report_delivered_packets,report_delivery_ratio,report_rtt_p95_ms,"
              "oam_time_average_aoi_ms,oam_peak_aoi_p95_ms,"
              "business_network_bytes,planned_telemetry_network_bytes,"
              "attempted_telemetry_network_bytes,telemetry_network_bytes,"
              "metadata_generated_bytes,mtu_exceeded_packets,mtu_drop_packets,device_queue_drop_packets,"
              "link_down_drop_packets,max_wire_packet_bytes\n";
    output << std::fixed << std::setprecision(6)
           << "ns-3,packet-level-system-cross-validation,drop-before-ip-fragmentation,"
           << m_variant << ',' << m_loadScale << ',' << m_seed << ',' << m_metrics.businessSent
           << ',' << m_metrics.businessDelivered << ',' << businessDeliveryRatio << ','
           << throughputMbps << ',' << Percentile(m_metrics.businessDelaysMs, 0.5) << ','
           << Percentile(m_metrics.businessDelaysMs, 0.95) << ','
           << Percentile(m_metrics.queueDelaysMs, 0.95) << ','
           << Percentile(m_metrics.businessQueueDelaysMs, 0.95) << ','
           << Percentile(m_metrics.telemetryQueueDelaysMs, 0.95) << ',' << m_metrics.probeSent << ','
           << m_metrics.reportDelivered << ',' << reportDeliveryRatio << ','
           << Percentile(m_metrics.reportRttsMs, 0.95) << ',' << averageAoiMs << ','
           << peakAoiP95Ms << ',' << m_metrics.businessNetworkBytes
           << ',' << m_metrics.plannedTelemetryNetworkBytes << ','
           << m_metrics.attemptedTelemetryNetworkBytes << ',' << m_metrics.telemetryNetworkBytes
           << ',' << m_metrics.metadataGeneratedBytes << ','
           << m_metrics.mtuDrops << ',' << m_metrics.mtuDrops << ','
           << m_metrics.deviceQueueDrops << ','
           << m_metrics.linkDownDrops << ',' << m_metrics.maxWirePacketBytes << '\n';
}

void
ValidationExperiment::Run()
{
    const double end = m_sliceCount * m_sliceDuration + m_reportTimeout;
    Simulator::Stop(Seconds(end));
    Simulator::Run();
    WriteResult();
    Simulator::Destroy();
}

} // namespace

int
main(int argc, char* argv[])
{
    std::string inputDir = "stage3-system-validation/fixtures/iridium-66-20slice";
    std::string output = "ns3-result.csv";
    std::string variant = "leo-selective";
    double loadScale = 1.0;
    uint32_t seed = 11;
    uint32_t sliceCount = 20;
    double sliceDuration = 1.0;
    uint32_t mtuBytes = 1500;
    uint32_t queuePackets = 100;
    uint32_t ipUdpOverhead = 28;
    double reportTimeout = 2.0;

    CommandLine command(__FILE__);
    command.AddValue("inputDir", "Experiment 13 frozen fixture directory", inputDir);
    command.AddValue("output", "Single-row CSV output", output);
    command.AddValue("variant", "no-int, full-int, or leo-selective", variant);
    command.AddValue("loadScale", "Business load multiplier", loadScale);
    command.AddValue("seed", "ns-3 seed", seed);
    command.AddValue("sliceCount", "Number of topology slices", sliceCount);
    command.AddValue("sliceDuration", "Compressed seconds per topology slice", sliceDuration);
    command.AddValue("mtuBytes", "Drop packets larger than this wire MTU", mtuBytes);
    command.AddValue("queuePackets", "Per-direction DropTail queue size", queuePackets);
    command.AddValue("ipUdpOverhead", "IPv4 and UDP wire overhead bytes", ipUdpOverhead);
    command.AddValue("reportTimeout", "Tail time for report delivery", reportTimeout);
    command.Parse(argc, argv);

    RngSeedManager::SetSeed(seed);
    ValidationExperiment experiment;
    experiment.Configure(inputDir,
                         output,
                         variant,
                         loadScale,
                         seed,
                         sliceCount,
                         sliceDuration,
                         mtuBytes,
                         queuePackets,
                         ipUdpOverhead,
                         reportTimeout);
    experiment.Build();
    experiment.Run();
    return 0;
}
